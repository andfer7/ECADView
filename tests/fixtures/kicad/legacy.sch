EESchema Schematic File Version 4
EELAYER 30 0
EELAYER END
$Descr A4 11693 8268
encoding utf-8
Sheet 1 2
Title "Legacy preview"
$EndDescr
$Comp
L missing:Device R1
U 1 1 5AAB499C
P 3000 2000
F 0 "R1" H 3000 1800 50 0000 C CNN
F 1 "1k" V 3200 2000 50 0000 L CIB
F 2 "Hidden footprint" H 3000 2000 50 0001 C CNN
	1 3000 2000
	0 1 1 0
$EndComp
$Comp
L power:GND #PWR01
U 1 1 5AAB499D
P 2000 2500
F 0 "#PWR01" H 2000 2200 50 0001 C CNN
F 1 "GND" H 2000 2700 50 0000 C CNN
	1 2000 2500
	1 0 0 -1
$EndComp
Wire Wire Line
	1000 2000 2000 2000
Wire Wire Line
	2000 2000 2000 2500
Connection ~ 2000 2000
Text Label 1000 2000 0 50 ~ 0
RETURN
Text GLabel 5000 2000 2 50 Input ~ 0
RETURN
Wire Wire Line
	5000 2000 5500 2000
Wire Notes Line
	1000 3000 2000 3000
Wire Bus Line
	5000 3500 6000 3500
Entry Wire Line
	5000 3400 5100 3500
Text Notes 1000 3200 0 50 ~ 0
Legacy <&> note\nsecond line
NoConn ~ 3000 2300
$Sheet
S 7000 2000 1500 1000
U 5AAB499E
F0 "Child" 50
F1 "child.sch" 50
F2 "IN" I L 7000 2200 50
$EndSheet
$EndSCHEMATC
