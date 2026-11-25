"""Regional rules for the markets the platform targets first: India, the UAE and the United States.

These are product defaults that encode widely known requirements. They are not legal advice;
each business remains responsible for its own compliance. Other countries fall back to a
conservative generic profile.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class RegionProfile:
    code: str
    name: str
    currency: str
    dial_code: str
    default_timezone: str
    # Window (recipient local time) in which promotional SMS and calls may be placed.
    marketing_window_start: str
    marketing_window_end: str
    # Marketing SMS/voice requires documented written consent (e.g. US TCPA).
    sms_voice_requires_written_consent: bool
    # Promotional email must carry the sender's physical postal address (e.g. US CAN-SPAM).
    email_requires_postal_address: bool
    # SMS sending requires DLT registration of entity, header and template (India TRAI).
    sms_requires_dlt: bool
    # SMS from local long codes requires A2P 10DLC brand/campaign registration (US).
    sms_requires_10dlc: bool
    regulations: tuple[dict, ...] = field(default_factory=tuple)


INDIA = RegionProfile(
    code="IN",
    name="India",
    currency="INR",
    dial_code="+91",
    default_timezone="Asia/Kolkata",
    marketing_window_start="09:00",
    marketing_window_end="21:00",
    sms_voice_requires_written_consent=False,
    email_requires_postal_address=False,
    sms_requires_dlt=True,
    sms_requires_10dlc=False,
    regulations=(
        {"name": "TRAI TCCCPR 2018 (DLT)",
         "summary": "Commercial SMS must use a DLT-registered Principal Entity ID, sender header and content "
                    "template. Promotional traffic is scrubbed against DND preferences by operators."},
        {"name": "Digital Personal Data Protection Act 2023",
         "summary": "Collect consent for a stated purpose, let people withdraw it as easily as they gave it, "
                    "and erase personal data when it is no longer needed or on request."},
        {"name": "Promotional hours",
         "summary": "Promotional SMS and calls are limited to 09:00 to 21:00 IST by default."},
    ),
)

USA = RegionProfile(
    code="US",
    name="United States",
    currency="USD",
    dial_code="+1",
    default_timezone="America/New_York",
    marketing_window_start="08:00",
    marketing_window_end="21:00",
    sms_voice_requires_written_consent=True,
    email_requires_postal_address=True,
    sms_requires_dlt=False,
    sms_requires_10dlc=True,
    regulations=(
        {"name": "TCPA",
         "summary": "Marketing texts and autodialed or prerecorded calls need prior express written consent. "
                    "Calls and texts are limited to 08:00 to 21:00 in the recipient's local time."},
        {"name": "CAN-SPAM Act",
         "summary": "Commercial email must identify the sender, include a valid physical postal address and an "
                    "unsubscribe link, and honour opt-outs within 10 business days."},
        {"name": "A2P 10DLC",
         "summary": "Register your brand and campaign with carriers before sending SMS from local numbers."},
        {"name": "Do Not Call",
         "summary": "Respect the National Do Not Call Registry and your own internal do-not-call list."},
    ),
)

UAE = RegionProfile(
    code="AE",
    name="United Arab Emirates",
    currency="AED",
    dial_code="+971",
    default_timezone="Asia/Dubai",
    # Calls 09:00-18:00 (Resolution 56/2024). Promotional SMS has its own 07:00-21:00 window (sms/rules.py).
    marketing_window_start="09:00",
    marketing_window_end="18:00",
    sms_voice_requires_written_consent=True,
    email_requires_postal_address=False,
    sms_requires_dlt=False,
    sms_requires_10dlc=False,
    regulations=(
        {"name": "TDRA unsolicited communications rules",
         "summary": "Marketing email and SMS need opt-in consent, must say who is sending and must offer a free, "
                    "easy way to opt out. Promotional SMS uses a sender ID starting with \"AD-\", comes only from "
                    "UAE-licensed businesses, is not delivered from 21:00 to 07:00 UAE time, and the consent list "
                    "is uploaded to TDRA's Consent Management System."},
        {"name": "Telemarketing rules (Cabinet Resolution 56 of 2024)",
         "summary": "Marketing calls only 09:00 to 18:00 UAE time from the business's own licensed UAE numbers. "
                    "Calls are recorded with a notice at the start. If someone says no, never call them again; "
                    "if they don't answer, retry at most once a day and twice a week. Never call numbers on the "
                    "Do Not Call Registry (DNCR). Fines run from AED 10,000 to AED 150,000 per violation."},
        {"name": "Personal Data Protection Law (Federal Decree-Law 45 of 2021)",
         "summary": "Consent is the default basis for marketing. People can ask to see, delete or move their "
                    "data, and data sent abroad needs safeguards. DIFC and ADGM have their own data laws."},
        {"name": "UAE VAT",
         "summary": "Signalcraft sells to UAE VAT-registered businesses. Invoices carry your TRN and no UAE VAT: "
                    "you account for VAT under the reverse charge."},
    ),
)

GENERIC = RegionProfile(
    code="XX",
    name="Other",
    currency="USD",
    dial_code="",
    default_timezone="UTC",
    marketing_window_start="09:00",
    marketing_window_end="21:00",
    sms_voice_requires_written_consent=True,
    email_requires_postal_address=True,
    sms_requires_dlt=False,
    sms_requires_10dlc=False,
    regulations=(
        {"name": "Consent first",
         "summary": "Without a configured regional profile, the strictest defaults apply: documented consent for "
                    "SMS and calls, a postal address in email, and daytime sending only."},
    ),
)

PROFILES = {"IN": INDIA, "AE": UAE, "US": USA}
SUPPORTED_REGIONS = ("IN", "AE", "US")
# Working days per market (Monday = 0). The UAE works Monday to Friday since 2022.
BUSINESS_DAYS = {"IN": (0, 1, 2, 3, 4, 5), "AE": (0, 1, 2, 3, 4), "US": (0, 1, 2, 3, 4)}


def business_days(country: str | None) -> tuple[int, ...]:
    return BUSINESS_DAYS.get((country or "").upper(), (0, 1, 2, 3, 4))


def profile_for(country: str | None) -> RegionProfile:
    return PROFILES.get((country or "").upper(), GENERIC)


def requires_written_consent(channel: str, jurisdiction: str | None) -> bool:
    return channel in ("sms", "voice") and profile_for(jurisdiction).sms_voice_requires_written_consent


# Common spellings found in uploaded files.
_COUNTRY_ALIASES = {
    "india": "IN", "bharat": "IN", "ind": "IN", "in": "IN", "+91": "IN", "91": "IN",
    "united states": "US", "united states of america": "US", "usa": "US", "us": "US", "u.s.": "US",
    "u.s.a.": "US", "america": "US", "+1": "US",
    "united kingdom": "GB", "uk": "GB", "great britain": "GB", "canada": "CA", "australia": "AU",
    "singapore": "SG", "united arab emirates": "AE", "uae": "AE", "u.a.e.": "AE", "emirates": "AE",
    "+971": "AE", "971": "AE", "dubai": "AE", "abu dhabi": "AE",
}


def normalize_country(value: str | None) -> str | None:
    """Return an ISO 3166-1 alpha-2 code for a free-text country, or None."""
    if not value:
        return None
    v = value.strip().lower()
    if v in _COUNTRY_ALIASES:
        return _COUNTRY_ALIASES[v]
    if len(v) == 2 and v.isalpha():
        return v.upper()
    return None


# Primary IANA timezone per US state (recipient-local quiet hours). Multi-zone states use the
# zone covering most of the population.
US_STATE_TIMEZONES = {
    "AL": "America/Chicago", "AK": "America/Anchorage", "AZ": "America/Phoenix", "AR": "America/Chicago",
    "CA": "America/Los_Angeles", "CO": "America/Denver", "CT": "America/New_York", "DE": "America/New_York",
    "DC": "America/New_York", "FL": "America/New_York", "GA": "America/New_York", "HI": "Pacific/Honolulu",
    "ID": "America/Boise", "IL": "America/Chicago", "IN": "America/Indiana/Indianapolis", "IA": "America/Chicago",
    "KS": "America/Chicago", "KY": "America/New_York", "LA": "America/Chicago", "ME": "America/New_York",
    "MD": "America/New_York", "MA": "America/New_York", "MI": "America/Detroit", "MN": "America/Chicago",
    "MS": "America/Chicago", "MO": "America/Chicago", "MT": "America/Denver", "NE": "America/Chicago",
    "NV": "America/Los_Angeles", "NH": "America/New_York", "NJ": "America/New_York", "NM": "America/Denver",
    "NY": "America/New_York", "NC": "America/New_York", "ND": "America/Chicago", "OH": "America/New_York",
    "OK": "America/Chicago", "OR": "America/Los_Angeles", "PA": "America/New_York", "RI": "America/New_York",
    "SC": "America/New_York", "SD": "America/Chicago", "TN": "America/Chicago", "TX": "America/Chicago",
    "UT": "America/Denver", "VT": "America/New_York", "VA": "America/New_York", "WA": "America/Los_Angeles",
    "WV": "America/New_York", "WI": "America/Chicago", "WY": "America/Denver", "PR": "America/Puerto_Rico",
}

US_STATE_NAMES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA",
    "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
    "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY", "puerto rico": "PR",
}


def us_state_code(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip()
    if v.upper() in US_STATE_TIMEZONES:
        return v.upper()
    return US_STATE_NAMES.get(v.lower())
