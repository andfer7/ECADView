"""Exact source/pin/name matching shared by the native document tabs."""


def identity(value):
    return str(value or "").strip().casefold()


def components_in_layout(identifier, row, target):
    links = target["layout_components"]
    names = set(target["components"])
    linked = [
        link
        for link in links
        if identifier and identity(link.get("source_id")) == identity(identifier)
    ]
    if linked:
        return {
            name
            for name in names
            if any(identity(name) == identity(link["name"]) for link in linked)
        }
    result = set()
    for name in names:
        link = next(
            (link for link in links if identity(link["name"]) == identity(name)), {}
        )
        if identifier and link.get("source_id"):
            continue
        if identity(link.get("source_name") or name) == identity(row["name"]):
            result.add(name)
    return result


def probe(source, target, components, nets):
    found_components, found_nets, missing = set(), set(), []
    schematic = source["kind"] == "schematic"
    for identifier in components:
        row = source["components"][identifier]
        if schematic:
            matches = components_in_layout(identifier, row, target)
        else:
            matches = {
                sid
                for sid, symbol in target["components"].items()
                if identifier in components_in_layout(sid, symbol, source)
            }
        if len(matches) == 1 or schematic and matches:
            found_components.update(matches)
        else:
            missing.append(row["name"])
    for identifier in nets:
        row = source["nets"][identifier]
        if schematic:
            by_pins = set()
            for terminal in row.get("terminals", []):
                symbols = [
                    (sid, symbol)
                    for sid, symbol in source["components"].items()
                    if identity(symbol["name"]) == identity(terminal.get("component"))
                ]
                for sid, symbol in symbols:
                    for component in components_in_layout(sid, symbol, target):
                        by_pins.update(
                            target["terminals"].get(
                                (component, terminal.get("pin")), set()
                            )
                        )
            aliases = {
                identity(name) for name in [row["name"], *row.get("aliases", [])]
            }
            matches = by_pins or {
                nid
                for nid, net in target["nets"].items()
                if identity(net["name"]) in aliases
            }
        else:
            matches = set()
            for nid in target["nets"]:
                _, resolved, _ = probe(target, source, set(), {nid})
                if identifier in resolved:
                    matches.add(nid)
        if len(matches) == 1:
            found_nets.update(matches)
        else:
            missing.append(row["name"] + (" (ambiguous)" if matches else ""))
    return found_components, found_nets, missing
