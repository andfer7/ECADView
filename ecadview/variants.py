"""Read Altium project assembly variants without opening linked documents."""

from pathlib import Path, PureWindowsPath
import posixpath

from altium_monkey.altium_prjpcb import AltiumPrjPcb


DOCUMENT_SUFFIXES = {".pcbdoc", ".schdoc"}


def document_path(value: str) -> str:
    """Keep the project-relative identity while accepting Windows separators."""
    return posixpath.normpath(str(value).strip().replace("\\", "/"))


def _field(row: dict, name: str, default=""):
    key = name.casefold()
    return next((value for field, value in reversed(tuple(row.items()))
                 if field.casefold() == key), default)


def _set_parameter(parameters: dict[str, str], name: str, value: str) -> None:
    if not name.strip():
        return
    existing = next((key for key in parameters if key.casefold() == name.casefold()), name)
    parameters[existing] = value


def _component_rows(variant: dict) -> list[dict]:
    components = {}
    for row in variant.get("variations", []):
        designator = str(_field(row, "Designator")).strip()
        unique_id = str(_field(row, "UniqueId")).strip()
        if not designator and not unique_id:
            continue
        key = ("id", unique_id.replace("/", "\\").casefold()) if unique_id else ("name", designator.casefold())
        components[key] = {
            "designator": designator,
            "unique_id": unique_id,
            "kind": {"1": "not_fitted", "2": "alternate"}.get(str(_field(row, "Kind")).strip(), "fitted"),
            "parameters": {},
            "alternate_part": str(_field(row, "AlternatePart") or _field(row, "AltLibLink_DesignItemID") or ""),
        }
    # Parameter rows can exist without a fitted-state variation. Keep them as
    # fitted components, while preserving an existing DNP/alternate selection.
    for designator, parameters in variant.get("parameter_overrides", {}).items():
        matching = [row for row in components.values() if row["designator"].casefold() == designator.casefold()]
        if not matching:
            row = {"designator": designator, "unique_id": "", "kind": "fitted", "parameters": {}, "alternate_part": ""}
            components[("name", designator.casefold())] = row
            matching = [row]
        for row in matching:
            for name, value in parameters.items():
                _set_parameter(row["parameters"], str(name), str(value))
    return list(components.values())


def project_metadata(path: Path) -> dict:
    """Return variant data only; uploaded projects cannot read server files."""
    project = AltiumPrjPcb(path)
    variants = []
    for name, variant in project.variants.items():
        parameters = {}
        for row in variant.get("parameters", []):
            key = str(_field(row, "Name") or _field(row, "ParameterName"))
            value = _field(row, "Value", None)
            if value is None:
                value = _field(row, "VariantValue")
            _set_parameter(parameters, key, str(value))
        variants.append({"name": name, "parameters": parameters, "components": _component_rows(variant)})
    current = project.get_current_variant()
    current = next((variant["name"] for variant in variants if current and variant["name"].casefold() == current.casefold()), None)
    documents = []
    seen = set()
    for row in project.documents:
        name = document_path(row["path"])
        if Path(name).suffix.lower() not in DOCUMENT_SUFFIXES or name.casefold() in seen:
            continue
        documents.append(name)
        seen.add(name.casefold())
    return {"kind": "project", "name": path.name, "documents": documents,
            "variants": variants, "current_variant": current, "warnings": []}


def resolve_document(project: Path, name: str) -> Path:
    """Resolve a CLI project member, including Windows case/separator spelling.

    Browser uploads only call project_metadata. Following file references is
    reserved for projects explicitly passed to the local command-line launcher.
    """
    if "\x00" in name or "://" in name:
        raise ValueError("invalid document path")
    normalized = document_path(name)
    relative = Path(normalized)
    if PureWindowsPath(normalized).is_absolute() and not relative.is_absolute():
        raise ValueError("Windows absolute path is unavailable on this system")
    path = relative if relative.is_absolute() else project.parent / relative
    if path.is_file():
        return path.resolve()
    # Altium projects are commonly moved from Windows to case-sensitive hosts.
    # Follow only unambiguous directory entries instead of guessing a match.
    absolute = path.absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        if part == "..":
            current = current.parent
            continue
        candidate = current / part
        if candidate.exists():
            current = candidate
            continue
        matches = [entry for entry in current.iterdir() if entry.name.casefold() == part.casefold()] if current.is_dir() else []
        if len(matches) != 1:
            raise FileNotFoundError(name)
        current = matches[0]
    if not current.is_file():
        raise FileNotFoundError(name)
    return current.resolve()
