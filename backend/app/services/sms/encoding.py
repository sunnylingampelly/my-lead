"""SMS encoding and segment counting (3GPP TS 23.038).

GSM-7 fits 160 characters in one SMS (153 per part when concatenated). Any character outside the
GSM-7 alphabet (Hindi, Tamil, emoji, curly quotes) forces UCS-2: 70 characters, 67 per part.
Extension-table characters ({ } [ ] ~ \\ | ^ €) cost two GSM-7 units.
"""
from dataclasses import dataclass

GSM7_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
GSM7_EXTENDED = set("^{}\\[~]|€\f")


@dataclass(frozen=True)
class SegmentInfo:
    encoding: str  # GSM-7 | UCS-2
    characters: int
    units: int
    segments: int
    per_segment: int
    remaining: int
    non_gsm: tuple[str, ...]


def analyse(text: str) -> SegmentInfo:
    non_gsm = tuple(sorted({ch for ch in text if ch not in GSM7_BASIC and ch not in GSM7_EXTENDED}))
    if not non_gsm:
        units = sum(2 if ch in GSM7_EXTENDED else 1 for ch in text)
        single, multi, enc = 160, 153, "GSM-7"
    else:
        # UCS-2 counts UTF-16 code units: most emoji take two.
        units = len(text.encode("utf-16-le")) // 2
        single, multi, enc = 70, 67, "UCS-2"
    if units == 0:
        return SegmentInfo(enc, 0, 0, 0, single, single, non_gsm)
    if units <= single:
        segments, per = 1, single
    else:
        per = multi
        segments = -(-units // multi)
    return SegmentInfo(enc, len(text), units, segments, per, segments * per - units, non_gsm[:20])
