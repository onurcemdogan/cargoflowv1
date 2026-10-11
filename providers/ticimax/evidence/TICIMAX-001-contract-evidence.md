# TICIMAX-001 Official Contract Evidence

Verified by human/operator from live official Ticimax documentation.

Source 1:
https://static.ticimax.com/dokumanlar/SiparisServis.pdf

SHA256:
BCB91573E32F6353B38E73D8E3E75F69C66430B949301D28709B2CC5AD29C4C3

Source 2:
https://static.ticimax.com/dokumanlar/webservis.pdf

SHA256:
49AF4D690DB730A4BD1476E8694DEEFECA728608B6A5CACB6A6558ADF9902F4F

## Verified SelectSiparis contract

Official SiparisServis documentation lists these parameters:

- UyeKodu
- WebSiparisFiltre
- WebSiparisSayfalama

Official Ticimax web service documentation gives the method signature:

SelectSiparis(
  string UyeKodu,
  WebSiparisFiltre f,
  WebSiparisSayfalama s
)

Decision for TICIMAX-001:

Use the official WebSiparisFiltre and
WebSiparisSayfalama contract names.

Do not use the frozen-pack-only
SiparisFiltre / SiparisSayfalama names
as substitutes for the official SOAP contract.

A tenant-specific WSDL, if supplied later,
remains the authoritative source for generated
SOAP schema details.