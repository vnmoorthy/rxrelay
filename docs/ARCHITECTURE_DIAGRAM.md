# RxRelay — detailed architecture diagram

This is the large system diagram used in the pitch deck (slide 08) and the GitHub README.

```mermaid
flowchart LR
  subgraph Edge["01 · Public edge"]
    Caller["Caller<br/>OTP-verified phone<br/>consented speech"]
    Tunnel["Cloudflare quick tunnel<br/>scripts/live-inbound.mjs<br/>→ :3001 only"]
    A1["a1mobile / Telnyx<br/>TeXML Gather + SpeechResult<br/>claim · point · SMS · OTP APIs"]
  end

  subgraph Voice["02 · Voice process · voice-server.mjs"]
    TeXML["/voice · /voice/turn · /health<br/>token-gated · no dashboard · no MCP"]
    Consent["Consent parse<br/>explicit phrase + scope<br/>vague yes rejected"]
    SafeStop["Safe stop<br/>clinical / emergency / Rx change<br/>→ human review"]
  end

  subgraph Core["03 · Shared core · src/"]
    PAVO["pavo.mjs<br/>demand-conditioned router<br/>fast · balanced · verified · stop"]
    Infer["inference.mjs<br/>a1 OpenAI Responses gateway<br/>+ local safe fallback"]
    Store["store.mjs + persist.mjs<br/>CaseStore · proof gate<br/>data/cases.json"]
  end

  subgraph App["04 · Dashboard / MCP · server.mjs"]
    Board["Proof board · public/<br/>lanes · timeline · 4/4 gate"]
    API["/api/cases · /mcp<br/>same consent + proof rules"]
    Tel["telephony.mjs<br/>sandbox by default<br/>live fails closed"]
  end

  subgraph Out["05 · Counterparts"]
    Pharmacy["Pharmacy<br/>status / blocker / ready"]
    Clinic["Clinic / insurer<br/>PA / follow-up outcome"]
    SMS["Patient SMS<br/>OTP allowlist only"]
    Human["Human owner<br/>escalation queue"]
  end

  Caller --> Tunnel --> TeXML
  A1 --> Tunnel
  TeXML --> Consent
  TeXML --> PAVO
  Consent --> SafeStop
  PAVO --> Infer --> Store
  Store <--> Board
  Store <--> API
  Store --> Tel
  Tel --> Pharmacy
  Tel --> Clinic
  Store --> SMS
  SafeStop --> Human

  classDef edge fill:#12324A,stroke:#7CE7D5,color:#EAF7FF;
  classDef voice fill:#0E4A44,stroke:#7CE7D5,color:#EAF7FF;
  classDef core fill:#1B3A5C,stroke:#7CE7D5,color:#EAF7FF;
  classDef danger fill:#3A1F24,stroke:#F0A0A0,color:#FFE8E8;
  classDef amber fill:#3A2A12,stroke:#E6A037,color:#FFF4E0;
  class Caller,Tunnel,A1 edge;
  class TeXML,PAVO,Infer,Store,Board,API voice;
  class Consent,SafeStop,Human danger;
  class Tel,Pharmacy amber;
```

## Proof gate (non-negotiable)

```text
explicit consent  ∧  permitted action  ∧  counterpart outcome  ∧  patient update
        │                    │                     │                     │
   voice/web record    provider-accepted      pharmacy/clinic       consented SMS
                       (sandbox or live)         recorded
                              └─────────────────────┬─────────────────────┘
                                                    ▼
                                          Resolution verified
```

## Trust rules

1. A public tunnel may only reach `voice-server.mjs` (`/voice`, `/voice/turn`, `/health`).
2. Evidence flags are set by state transitions — never by model output.
3. Live outbound requires OTP-verified `LIVE_ALLOWED_RECIPIENTS` and a provider action id.
4. Safe-stop / human-review blocks autonomous outreach.
