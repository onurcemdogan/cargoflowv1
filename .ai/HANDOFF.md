# DevFactory handoff

Ticket: ARAS-EXPANSION
Branch: `agent/ARAS-EXPANSION`
Status: `CI_PENDING`
HEAD: `28d637aab9fa3fc3611e630ba963dc279ded6e66` (committed, pending push)
Spec: `.ai/tickets/ARAS-EXPANSION.md`
PR: https://github.com/onurcemdogan/cargoflowv1/pull/8

## Codex merge-control finding CODEX-MERGE-691b9a2e44796cef (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope><!--a---><ResultCode>0</ResultCode></Envelope>` passes because the comment validator checks only internal `--`, allowing comment content ending in `-`. Stripping that invalid comment exposes ResultCode=0 as success. Reject trailing-hyphen comment content or use a strict XML parser, and add regression coverage before merging.

Root cause: `stripNonElementXmlConstructs`'s comment-content check (added for `CODEX-MERGE-1731df62de0cbe8e`) rejects a lazy-matched comment interior only if it contains the forbidden substring `--`, but never checks whether that interior *ends* in a hyphen. XML's `Comment` production (`Comment ::= '<!--' ((Char - '-') | ('-' (Char - '-')))* '-->'`) requires that if the last repetition of the content is a hyphen, it must be followed by a `(Char - '-')` — but here it is immediately followed by the `-->` delimiter itself (which starts with `-`), so content ending in a bare hyphen is forbidden independent of whether `--` appears earlier in the content. Because the strip regex is lazy (matches up to the *first* `-->` it finds), the finding body `<Envelope><!--a---><ResultCode>0</ResultCode></Envelope>` resolves to interior `"a-"` (a single trailing hyphen, no internal `--`) — the existing `includes('--')` check had nothing to reject, so the comment was stripped as an ordinary, legal comment, leaving `<Envelope><ResultCode>0</ResultCode></Envelope>` to pass well-formedness. `extractKnownXmlFields` then read `ResultCode='0'`, and `classifyArasSetOrderResult` (`arasContract.ts`) treats `ResultCode === '0'` as success — confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding body, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): added `|| match[1].endsWith('-')` alongside the existing `match[1].includes('--')` check in `stripNonElementXmlConstructs`'s comment-interior scan. Any comment whose lazy-matched interior ends in a hyphen is now rejected (`return null`, surfacing as `ARAS_MALFORMED_RESPONSE`) before stripping, exactly the same way one containing an internal `--` already was. No other well-formedness logic changed — the CDATA-span carve-out, the existing strip pass, and `parseWellFormedXmlStructure`'s null-check on `stripNonElementXmlConstructs`'s return value are all unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3ad`: the exact body from the finding, `<Envelope><!--a---><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 78/78 (was 77/77; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed `28d637aab9fa3fc3611e630ba963dc279ded6e66` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state, then request a fresh Codex merge decision against `28d637aab9fa3fc3611e630ba963dc279ded6e66`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-1731df62de0cbe8e (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `stripNonElementXmlConstructs` removes `<!--a--b-->` without validating the forbidden internal `--`, so `<Envelope><!--a--b--><ResultCode>0</ResultCode></Envelope>` yields a successful ResultCode. Validate constructs before stripping or use a strict XML parser, and add regression coverage. Green CI does not resolve this defect.

Root cause: `stripNonElementXmlConstructs`'s comment-stripping regex (`<!--[\s\S]*?-->`) is lazy, so it matches only up to the *first* `-->` it finds — but it never validated that a matched comment's interior is itself legal XML. XML's `Comment` production (`'<!--' ((Char - '-') | ('-' (Char - '-')))* '-->'`) forbids the string `--` from occurring anywhere within comment content, precisely so the `-->` end delimiter can never be ambiguous. A body like `<Envelope><!--a--b--><ResultCode>0</ResultCode></Envelope>` has content `a--b` (which contains a forbidden `--`) between the opening `<!--` and the first `-->` — the lazy regex still matched and stripped the whole `<!--a--b-->` construct as if it were one ordinary, legal comment, leaving a clean-looking `<Envelope><ResultCode>0</ResultCode></Envelope>` that passed well-formedness. `extractKnownXmlFields` then read `ResultCode='0'`, and `classifyArasSetOrderResult` (`arasContract.ts`) treats `ResultCode === '0'` as success — confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding body, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): `stripNonElementXmlConstructs` now returns `string | null` instead of always `string`. Before running its existing strip pass, it first scans the raw body for every `<!--([\s\S]*?)-->` match (the same lazy comment shape, so it identifies exactly the same "comments" the strip pass would act on), skipping any match whose start index falls inside a CDATA span (CDATA content is opaque literal text — a comment-shaped substring inside one is not a real comment, consistent with the existing CDATA-opacity handling from `CODEX-MERGE-a14f3b696b9f30e7`/`CODEX-MERGE-8222e34b89e08fa9`). If any such comment's captured interior contains `--`, the function returns `null` instead of stripping anything. `parseWellFormedXmlStructure` now checks this return value for `null` immediately after calling it (in addition to the existing null return after the well-formedness tag scan) and returns `null` — surfacing as `ARAS_MALFORMED_RESPONSE` — if so. The existing strip pass itself, and all other well-formedness logic, are unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3ac`: the exact body from the finding, `<Envelope><!--a--b--><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 77/77 (was 76/76; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed `3f2d51dcc53511396b39e404fd0328c2d1581e70` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state, then request a fresh Codex merge decision against `3f2d51dcc53511396b39e404fd0328c2d1581e70`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-9b57a39bd4fbdcb2 (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `stripNonElementXmlConstructs` removes comments before character validation, so `<Envelope><!--\u0000--><ResultCode>0</ResultCode></Envelope>` containing a literal NUL yields `ResultCode='0'`. Validate character legality on the original response before stripping constructs and add regression coverage. Green CI does not resolve this remaining defect.

Root cause: the character-legality checks (`hasInvalidLiteralChar`, added for `CODEX-MERGE-eba1a34bb5502189`) only ever ran on the post-strip `cleaned` string — the inter-tag gaps and attribute values inspected during the tag-matching scan. But `stripNonElementXmlConstructs` deletes comments/PI/DOCTYPE (and whatever illegal characters happen to sit inside them) *before* that `cleaned` string exists, on the theory that their content has no extraction value. Character legality (the XML `Char` production) is a document-wide constraint that applies to every literal character in the RAW response regardless of which construct contains it — a comment's content still has to consist of legal XML characters even though the comment itself is discarded. A body like `<Envelope><!--\u0000--><ResultCode>0</ResultCode></Envelope>` therefore had its NUL erased along with the whole comment during stripping, so the resulting cleaned body (`<Envelope><ResultCode>0</ResultCode></Envelope>`) wrongly validated as well-formed, and `extractKnownXmlFields` read `ResultCode='0'` — confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding body, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): added a single `hasInvalidLiteralChar(trimmed)` call in `parseWellFormedXmlStructure`, on the raw/unstripped body, immediately after the existing `startsWith('<')` check and *before* `stripNonElementXmlConstructs` runs. Any illegal literal character anywhere in the raw response — inside a comment, PI, DOCTYPE, CDATA span, or plain text — now rejects the body as `ARAS_MALFORMED_RESPONSE` before stripping has a chance to hide it. The pre-existing gap-text and attribute-value `hasInvalidLiteralChar` checks against the `cleaned` string are unchanged; they are now redundant for comment/PI/DOCTYPE-hidden cases (since the new upfront check already catches those) but remain correct and still needed for illegal characters that survive stripping (plain text gaps, attribute values, CDATA).

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3ab`: the exact body from the finding, `<Envelope><!--\u0000--><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 76/76 (was 75/75; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed `bc787c427f28f242ad8d651b4e16a5c989a64c61` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state, then request a fresh Codex merge decision against `bc787c427f28f242ad8d651b4e16a5c989a64c61`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-eba1a34bb5502189 (repaired, code change applied)

Finding: `arasClient.ts` validates numeric character references (`&#NNN;`) but still accepts a *literal* invalid XML character typed directly into the body. A response containing an actual `U+0000` byte inside `<Other>`, followed by `<ResultCode>0</ResultCode>`, passes the supplied parser and yields a success code. Require XML character legality throughout the response (not just for entity references) and add regression coverage before reconsidering merge.

Root cause: `hasInvalidEntityReference` (hardened for numeric-reference code-point legality by `CODEX-MERGE-94d9708343f9b1d6`) only ever inspects text reached via `&`-prefixed entity/numeric-reference syntax. XML character legality (the `Char` production) is a document-wide constraint on every literal character — it applies regardless of whether that character arrived as a raw byte or an escaped reference, and it applies even inside CDATA (CDATA only suppresses markup/entity *recognition*, not the underlying character-legality rule). A body like `<Envelope><Other>\u0000</Other><ResultCode>0</ResultCode></Envelope>` (an actual NUL byte, not the entity `&#0;` already rejected by the prior fix) therefore still passed as well-formed — there is no `&` anywhere in it, so `hasInvalidEntityReference` never had anything to flag — so `extractKnownXmlFields` read `ResultCode='0'` and `classifyArasSetOrderResult` (`arasContract.ts`) treated `ResultCode === '0'` as success. Confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding scenario, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): added `hasInvalidLiteralChar(text)`, which iterates every code point of the given text via `for...of` (which iterates by Unicode code point, so both surrogate pairs and unpaired surrogates are handled correctly — an unpaired surrogate correctly fails `isValidXmlCodePoint` since the surrogate range is excluded from `Char`) and applies the same `isValidXmlCodePoint` rule already used for numeric character references. Wired into `parseWellFormedXmlStructure` at two call sites: (1) the full inter-tag gap, checked *before* any CDATA carve-out — unlike the entity-reference check (which is CDATA-exempt, since entity syntax isn't processed there), raw character legality applies inside CDATA too, so this check must see the un-stripped gap; and (2) each attribute value, alongside the existing duplicate-attribute-name and entity-reference checks. No other well-formedness logic changed.

Regression tests added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3y`: the exact finding scenario, `<Envelope><Other>\u0000</Other><ResultCode>0</ResultCode></Envelope>` (literal NUL in character data) — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.
- `ARC-3z`: literal NUL inside an attribute value, `<Envelope><Other a="\u0000"/><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.
- `ARC-3aa`: literal NUL inside a CDATA span, `<Envelope><Other><![CDATA[\u0000]]></Other><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null` (confirms character legality is enforced even where CDATA otherwise makes markup/entities opaque).

Verification this round:
- `npm run test:aras`: 75/75 (was 72/72; +3 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed `4ec62213be61b9d4aa5787f5c58392eccd64d166` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state, then request a fresh Codex merge decision against `4ec62213be61b9d4aa5787f5c58392eccd64d166`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-94d9708343f9b1d6 (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope><Other>&#0;</Other><ResultCode>0</ResultCode></Envelope>`. `VALID_ENTITY_REFERENCE` accepts numeric references without validating XML character ranges, so this invalid response yields `ResultCode='0'` and false create success. Require strict character-reference validation and regression tests before reconsideration.

Root cause: `VALID_ENTITY_REFERENCE` (the regex hardened for entity-reference well-formedness by `CODEX-MERGE-ff386c6c9acf66cb`/`CODEX-MERGE-fd3a21282f11cc5f`) accepted any `&#[0-9]+;` (decimal) or `&#x[0-9a-fA-F]+;` (hex) purely by syntax shape — it never checked whether the numeric code point the reference names is itself a legal XML character. XML 1.0's `Char` production is `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`, which explicitly excludes the C0 control range (including NUL, `#x0`) and the UTF-16 surrogate range. A body like `<Envelope><Other>&#0;</Other><ResultCode>0</ResultCode></Envelope>` therefore still passed `hasInvalidEntityReference` — the reference `&#0;` is syntactically a well-formed numeric character reference, it just names an illegal character — so `extractKnownXmlFields` read `ResultCode='0'` and `classifyArasSetOrderResult` (`arasContract.ts`) treated `ResultCode === '0'` as success. Confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding body, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): added `isValidXmlCodePoint(codePoint)`, implementing the XML 1.0 `Char` production exactly (the 3 discrete control-char exceptions plus the 3 valid ranges, in order up to the full Unicode range including astral code points). `hasInvalidEntityReference` now iterates every `VALID_ENTITY_REFERENCE` match via `matchAll`; for any match whose body starts with `#` (i.e. a numeric reference, decimal or hex), it parses the referenced code point and rejects the text (`return true`) if `isValidXmlCodePoint` is false. This runs in addition to — not instead of — the pre-existing check (`replace(...).includes('&')`) that catches undeclared *named* entity references (e.g. `&undefined;`) and bare `&`. The five predefined named entities (`lt`/`gt`/`amp`/`apos`/`quot`) are untouched by the new check since they never look like numeric references and always resolve to valid XML characters. Both the inter-tag gap-text call site (added for `CODEX-MERGE-ff386c6c9acf66cb`) and the attribute-value call site (added for `CODEX-MERGE-fd3a21282f11cc5f`) call the same `hasInvalidEntityReference`, so both now benefit from the range check with no additional call-site changes needed.

Regression tests added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3w`: the exact body from the finding, `<Envelope><Other>&#0;</Other><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.
- `ARC-3x`: legitimate numeric character references (`&#9;` tab, `&#x20;` space) — asserts `outcome.ok === true` and `outcome.raw.ResultCode === '0'`, confirming the range check does not regress valid numeric references.

Verification this round:
- `npm run test:aras`: 72/72 (was 70/70; +2 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed `18e838f90d0e052a9396b8fc0a9638ee4b16369b` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state, then request a fresh Codex merge decision against `18e838f90d0e052a9396b8fc0a9638ee4b16369b`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-fd3a21282f11cc5f (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope><Other a="&undefined;"/><ResultCode>0</ResultCode></Envelope>` passes because entity validation checks text gaps but not attribute values, allowing `ResultCode='0'` to produce false create success. Require strict XML validation covering attributes and a regression test before reconsideration.

Root cause: `hasInvalidEntityReference` (added for `CODEX-MERGE-ff386c6c9acf66cb`) was wired only into the inter-tag gap-text check in `parseWellFormedXmlStructure`. Attribute values are character data too and are subject to the identical well-formedness rule (a literal `&` in text is only valid XML if it starts one of the five predefined entities or a numeric character reference), but the opening/self-closing tag's attribute-value character classes (`[^"<]*` / `[^'<]*`, hardened against raw `<` for `CODEX-MERGE-af151267b7f3521e`) accepted any other `&name;` as ordinary attribute text. A body like `<Envelope><Other a="&undefined;"/><ResultCode>0</ResultCode></Envelope>` therefore still passed as well-formed: tags balance, there is exactly one root, and the only inter-tag gap text is whitespace (the invalid entity sits inside an attribute value, not a text gap, so the existing check never saw it). `extractKnownXmlFields` then read `ResultCode='0'`, and `classifyArasSetOrderResult` (`arasContract.ts`) treats `ResultCode === '0'` as success — confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding body, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): the attribute-matching regex (already used to collect `attrNames` for the duplicate-attribute-name check added for `CODEX-MERGE-4c541f2475a1489c`) now also captures each attribute's value via alternation capture groups (`(?:"([^"<]*)"|'([^'<]*)')`). After the existing duplicate-name check, every captured value (`m[2] ?? m[3]`) is passed through the same `hasInvalidEntityReference` helper used for gap text. Since attributes cannot contain CDATA, no CDATA carve-out is needed for this check (unlike the gap-text check, which strips CDATA spans first). Any attribute value containing an invalid entity reference now rejects the tag, so the body is classified `ARAS_MALFORMED_RESPONSE` instead of the invalid reference being silently accepted as text. All other well-formedness checks (tag balance, single root, gap/trailing-text checks, duplicate-attribute-name/`<`-in-value rejection, delimiter-to-name whitespace, CDATA handling, gap-text entity checks) are unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3v`: the exact body from the finding, `<Envelope><Other a="&undefined;"/><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 70/70 (was 69/69; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `c7967df480b24459b6ea91c4f5819ba37f3fdcab` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `c7967df480b24459b6ea91c4f5819ba37f3fdcab`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-ff386c6c9acf66cb (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope><Other>&undefined;</Other><ResultCode>0</ResultCode></Envelope>` passes tag balancing and yields `ResultCode='0'` because entity references in character data are never validated. This permits false create success. Require strict XML validation and a regression test before reconsidering merge.

Root cause: in `parseWellFormedXmlStructure`, the tag-matching scan validated tag balance, nesting, single-root, and outside-root gap text — but never inspected character data (text between tags) for entity-reference well-formedness. XML forbids a literal `&` in text unless it starts one of the five predefined entities (`lt`/`gt`/`amp`/`apos`/`quot`) or a numeric character reference (`&#NNN;`/`&#xHHHH;`); any other name is an undeclared general entity reference, which is a well-formedness violation without a DTD declaring it (WFC: Entity Declared). A body like `<Envelope><Other>&undefined;</Other><ResultCode>0</ResultCode></Envelope>` therefore still passed as well-formed — its tags balance, it has exactly one root, and there is no stray text outside the root — despite `&undefined;` being invalid XML. Traced by hand against the exact finding body: `extractKnownXmlFields` read `ResultCode='0'` from the accepted structure, and `classifyArasSetOrderResult` (`arasContract.ts`) treats `ResultCode === '0'` as success, so the malformed body was misclassified as a successful create — confirmed as a live, reproducible bug against the current `arasClient.ts`, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): added `hasInvalidEntityReference(text)`, which strips every valid entity reference (a `VALID_ENTITY_REFERENCE` regex covering the 5 predefined names plus decimal/hex numeric character references) out of the given text and reports whether any `&` remains. In the tag-matching scan, the inter-tag gap text (`cleaned.slice(cursor, match.index)`) is now always computed up front — previously it was only computed when `stack.length === 0`, so text inside an open element (like `<Other>&undefined;</Other>`) was never examined at all. Any CDATA span is stripped out of that gap before validation, since entity syntax is never processed inside CDATA (consistent with the existing CDATA-opacity handling from `CODEX-MERGE-a14f3b696b9f30e7`/`CODEX-MERGE-8222e34b89e08fa9`). If the remaining (non-CDATA) text contains an invalid entity reference, the body is now rejected as malformed — this check runs unconditionally, both inside and outside the root, before the pre-existing outside-root whitespace-only check. All other well-formedness checks (tag balance, single root, gap/trailing-text, attribute duplicate-name/`<`-in-value rejection, delimiter-to-name whitespace, CDATA handling) are unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3u`: the exact body from the finding, `<Envelope><Other>&undefined;</Other><ResultCode>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 69/69 (was 68/68; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `5ec22c2cb82668fbea9bcca52705fab1bde26820` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `5ec22c2cb82668fbea9bcca52705fab1bde26820`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-eb3de5b61561ebdd (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope>< ResultCode>0</ ResultCode></Envelope>` passes both tag regexes and extracts `ResultCode='0'`, allowing false create success. Reject whitespace between tag delimiters and element names, and add a regression test before reconsidering merge.

Root cause: in `parseWellFormedXmlStructure`, both the opening/self-closing tag regex (anchored end-to-end by `CODEX-MERGE-67921c7e4afaad12`, attribute-hardened by `CODEX-MERGE-4c541f2475a1489c`/`CODEX-MERGE-af151267b7f3521e`) and the closing tag regex (anchored by `CODEX-MERGE-2f65a0c9946b73be`) still had a `\s*` immediately after the leading `<` (opening) or `</` (closing), before the element name capture group. XML's grammar forbids this: `STag ::= '<' Name (S Attribute)* S? '>'` and `ETag ::= '</' Name S? '>'` both require the name to immediately follow the delimiter, with no intervening whitespace — a bare `<` (or `</`) followed by whitespace is not a tag opener with leading space, it simply is not a valid tag at all. Because both anchored regexes still tolerated that whitespace, `< ResultCode>` and `</ ResultCode>` were each accepted as legitimate name-bearing tags. Traced by hand against the exact finding body `<Envelope>< ResultCode>0</ ResultCode></Envelope>`: the opening `< ResultCode>` matched with captured name `"ResultCode"` and was pushed onto the stack, the closing `</ ResultCode>` matched the same name and popped it, so the element was recorded with content `"0"`, `extractKnownXmlFields` read `ResultCode='0'`, and `classifyArasSetOrderResult` (`arasContract.ts`) treats `ResultCode === '0'` as success — confirmed as a live, reproducible bug against the current `arasClient.ts`, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): removed the `\s*` immediately after `<` in the opening/self-closing tag regex (now `/^<([A-Za-z_][\w.:-]*).../`) and immediately after `<\/` in the closing tag regex (now `/^<\/([A-Za-z_][\w.:-]*)\s*>$/`). Whitespace is still permitted (as required by the grammar) between the name and the attributes/`>`/`/>` in both regexes — only the delimiter-to-name gap was tightened. Any tag with whitespace inserted right after `<` or `</` now fails `nameMatch` and the body is rejected as `ARAS_MALFORMED_RESPONSE`. All other well-formedness checks (attribute duplicate-name/`<`-in-value rejection, tag balance, single root, gap/trailing-text checks, CDATA handling) are unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3t`: the exact body from the finding, `<Envelope>< ResultCode>0</ ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 68/68 (was 67/67; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `3a48671` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `3a48671`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-af151267b7f3521e (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope><ResultCode a="<">0</ResultCode></Envelope>` passes the attribute regex and extracts `ResultCode='0'`, permitting false create success. Reject invalid XML attribute values through complete XML validation and add a regression test before reconsidering merge.

Root cause: in `parseWellFormedXmlStructure`, the attribute-value pattern used by both the opening/self-closing tag `nameMatch` regex (anchored end-to-end by `CODEX-MERGE-67921c7e4afaad12`) and the `attrNames` duplicate-name scan (added for `CODEX-MERGE-4c541f2475a1489c`) accepted **any** character except the delimiting quote — `[^"]*` inside double quotes, `[^']*` inside single quotes. XML forbids a literal, unescaped `<` inside an attribute value (it must be written as `&lt;`); a raw `<` there is always the start of a new tag, never data. Neither regex enforced this. A tag like `<ResultCode a="<">` therefore still matched cleanly — the embedded `<` was accepted as ordinary attribute text — so `extractKnownXmlFields` read `ResultCode='0'` from the accepted element and `classifyArasSetOrderResult` (`arasContract.ts`) treated `ResultCode === '0'` as success. Confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding body `<Envelope><ResultCode a="<">0</ResultCode></Envelope>`, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): excluded `<` from both attribute-value character classes — `[^"<]*` and `[^'<]*` — in the opening/self-closing tag `nameMatch` regex and the `attrNames` scan regex, kept in sync so both regexes agree on what counts as a valid attribute value. Any tag with an embedded raw `<` in an attribute value now fails `nameMatch` entirely, so the body is rejected as `ARAS_MALFORMED_RESPONSE` instead of the `<` being silently accepted as text. Legitimate attribute values that don't contain a raw `<` (e.g. real SOAP envelopes carrying `xmlns:soap="..."`) are unaffected. Closing-tag matching, duplicate-attribute-name rejection, tag balance, single-root, gap/trailing-text checks, and CDATA handling are all unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3s`: the exact body from the finding, `<Envelope><ResultCode a="<">0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 67/67 (was 66/66; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `0b40ee1` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `0b40ee1fbf98e005ce9511d693c3957525d9b06e`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-4c541f2475a1489c (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope><ResultCode a="1" a="2">0</ResultCode></Envelope>` passes its opening-tag regex despite duplicate attributes, extracts `ResultCode='0'`, and permits false create success. Replace the partial XML validator with complete validation and add a regression test before reconsidering merge.

Root cause: in `parseWellFormedXmlStructure`, the opening/self-closing tag regex (anchored end-to-end by `CODEX-MERGE-67921c7e4afaad12`) validates that each attribute individually looks like `name="value"` (or `'value'`) via a repeated `(?:...)*` group — but a regex repetition group has no memory of names it already consumed in earlier repetitions, so it never enforced that attribute *names* be distinct within one tag. XML's well-formedness rules explicitly forbid an element from carrying the same attribute name twice. A tag like `<ResultCode a="1" a="2">` therefore still matched cleanly — both `a="1"` and `a="2"` are individually valid attribute syntax — so `extractKnownXmlFields` read `ResultCode='0'` from the accepted element and `classifyArasSetOrderResult` (`arasContract.ts`) treated `ResultCode === '0'` as success. Confirmed as a live, reproducible bug against the current `arasClient.ts` using the exact finding body `<Envelope><ResultCode a="1" a="2">0</ResultCode></Envelope>`, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): after the existing anchored `nameMatch` regex succeeds (confirming the tag's only content besides the element name is zero or more well-formed attribute assignments), extract every attribute name in the tag with `tag.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"[^"]*"|'[^']*')/g)` and reject the tag (`return null`, surfacing as `ARAS_MALFORMED_RESPONSE`) if `new Set(attrNames).size !== attrNames.length` — i.e. if any attribute name repeats. This scan is safe to run unconditionally on any tag that already passed `nameMatch`, since that anchored regex guarantees there is nothing in the tag besides the name and valid attribute syntax to misinterpret. Legitimate tags with distinct attribute names (e.g. real SOAP envelopes carrying `xmlns:soap="..." xmlns:xsi="..."`) are unaffected. Closing-tag matching, self-closing detection, and all prior well-formedness checks (tag balance, single root, gap/trailing-text checks, CDATA handling) are unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3r`: the exact body from the finding, `<Envelope><ResultCode a="1" a="2">0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 66/66 (was 65/65; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `5efa7fc` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `5efa7fc`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-67921c7e4afaad12 (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed opening tags: `<Envelope><ResultCode !>0</ResultCode></Envelope>` passes the prefix-only opening-tag check and extracts `ResultCode='0'`, permitting false create success. Require complete XML validation and a regression test before reconsidering merge.

Root cause: in `parseWellFormedXmlStructure`, both the opening-tag and self-closing-tag branches matched the element name with `/^<\s*([A-Za-z_][\w.:-]*)/` — a **prefix** match with no end anchor, never checking what came after the captured name. Unlike a closing tag (already anchored by `CODEX-MERGE-2f65a0c9946b73be`), an opening tag legitimately *can* carry attributes, so the fix couldn't simply forbid trailing content — it needed to validate that content is actually attribute syntax. The prior code validated neither: for `<ResultCode !>`, the regex matched `"ResultCode"` and silently discarded the bogus `" !"` as if it were legitimate attributes. Traced by hand against the exact finding body `<Envelope><ResultCode !>0</ResultCode></Envelope>`: the closing tag `</ResultCode>` still matched the stack top by name, so the element was recorded with content `"0"`, `extractKnownXmlFields` read `ResultCode='0'`, and `classifyArasSetOrderResult` (`arasContract.ts`) treats `ResultCode === '0'` as success — confirmed as a live, reproducible bug against the current `arasClient.ts`, not stale evidence.

Fix (`server/carriers/aras/arasClient.ts`): replaced the prefix-only opening/self-closing regex with a full-match regex requiring the name to be followed only by zero or more whitespace-separated `name="value"` (or `'value'`) attributes, then an optional `/` and `>`, anchored at both ends: `/^<\s*([A-Za-z_][\w.:-]*)(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/)?>$/`. Any non-whitespace, non-attribute content between the name and the tag's end (e.g. `" !"`) now fails the match, so the body is rejected as `ARAS_MALFORMED_RESPONSE` instead of the garbage being silently discarded. Self-closing detection is now derived from the same match (capture group 2) instead of a separate `/\/\s*>$/` pre-check, so there is a single source of truth for what counts as a valid opening/self-closing tag. Legitimate attributes (e.g. `xmlns:soap="..."` on real SOAP envelopes) still parse correctly. Closing-tag matching is unchanged.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3q`: the exact body from the finding, `<Envelope><ResultCode !>0</ResultCode></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 65/65 (was 64/64; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `42dd0f4` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `42dd0f4`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-2f65a0c9946b73be (repaired, code change applied)

Finding: `arasClient.ts` still accepts malformed XML: `<Envelope><ResultCode>0</ResultCode junk></Envelope>` passes the prefix-only closing-tag check and extracts `ResultCode='0'`, permitting false create success. Require strict XML validation and a regression test before merge.

Root cause: in `parseWellFormedXmlStructure`, the closing-tag branch matched the element name with `/^<\/\s*([A-Za-z_][\w.:-]*)/` — a **prefix** match with no end anchor. XML forbids anything but whitespace between a closing tag's name and its `>` (unlike an opening tag, a closing tag cannot carry attributes), but this regex never checked what came after the captured name. So the tag `</ResultCode junk>` still captured group `"ResultCode"`, matched the stack top, and was accepted as a legitimate close — the trailing `" junk"` was silently discarded rather than causing rejection. Traced by hand: for body `<Envelope><ResultCode>0</ResultCode junk></Envelope>`, `extractKnownXmlFields` then read `ResultCode` from `cleaned.slice(22,23)` = `"0"`, and `classifyArasSetOrderResult` (`arasContract.ts`) treats `ResultCode === '0'` as success — so the malformed body was misclassified as a successful create, exactly as the finding describes. This was a live, reproducible bug (not stale evidence), confirmed against the current `arasClient.ts` before patching.

Fix (`server/carriers/aras/arasClient.ts`): anchored the closing-tag regex to `/^<\/\s*([A-Za-z_][\w.:-]*)\s*>$/` — it now requires the entire tag to be `</`, optional whitespace, the name, optional whitespace, and `>` with nothing else. Any non-whitespace between the name and `>` (e.g. `" junk"`) now fails the match, `nameMatch` is `null`, and the function returns `null` (`ARAS_MALFORMED_RESPONSE`) instead of silently accepting the tag. Opening/self-closing tag matching is unchanged (attributes remain legitimately permitted there).

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3p`: the exact body from the finding, `<Envelope><ResultCode>0</ResultCode junk></Envelope>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 64/64 (was 63/63; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `9dac45e` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `9dac45e`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-8222e34b89e08fa9 (repaired, code change applied)

Finding: `arasClient.ts` strips comments before identifying CDATA spans. A response containing `<ResultCode><![CDATA[0<!--99-->]]></ResultCode>` therefore extracts `'0'`, although its actual value is `'0<!--99-->'`. This can falsely classify a rejected create as successful.

Root cause: `stripNonElementXmlConstructs` removed comments/PI/DOCTYPE with a single CDATA-unaware regex pass over the whole raw body. A comment-shaped substring sitting *inside* a CDATA payload (`<!--99-->` inside `<![CDATA[0<!--99-->]]>`) was indistinguishable, from that regex's perspective, from a real comment, so it was deleted. This happened *before* `parseWellFormedXmlStructure` located CDATA spans (it only found them on the already-stripped string), so the CDATA content was corrupted from the literal text `"0<!--99-->"` to `"0"` before extraction ever ran. `extractKnownXmlFields` then returned `ResultCode: '0'`, and since `classifyArasSetOrderResult` treats exactly `'0'` as success, a response whose true value was `'0<!--99-->'` (i.e. not `'0'` — per the finding's premise, a rejected create) could be misclassified as a successful create.

Fix (`server/carriers/aras/arasClient.ts`):
- Added `findCdataSpans(xml)`, extracted from the span-location logic `parseWellFormedXmlStructure` already used, now shared by both call sites.
- Rewrote `stripNonElementXmlConstructs` to locate CDATA spans on the **raw, pre-strip** body first, then strip comments/PI/DOCTYPE via a single indexed `matchAll` pass over the combined pattern, skipping any match whose start index falls inside a located CDATA span. Matches outside CDATA are still removed exactly as before. Because the CDATA boundaries are computed before any stripping happens, a comment-shaped (or PI/DOCTYPE-shaped) substring inside a CDATA payload is now left completely untouched, delimiters and all.
- `parseWellFormedXmlStructure` is otherwise unchanged: it still calls `stripNonElementXmlConstructs(trimmed)` to get `cleaned`, then computes `cdataSpans` on `cleaned` via the shared `findCdataSpans` helper (previously an inline duplicate of the same regex) before doing the CDATA-aware tag scan. Since `cleaned` no longer has CDATA-internal content corrupted, these spans and the subsequent element/field extraction are now correct.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3o`: the exact body from the finding, `<Envelope><ResultCode><![CDATA[0<!--99-->]]></ResultCode></Envelope>` — asserts `outcome.ok === true` (body is well-formed) and `outcome.raw.ResultCode === '0<!--99-->'` (CDATA text, including the comment-shaped substring, is preserved verbatim), and `classifyArasSetOrderResult(outcome.raw).ok === false` (correctly not classified as success, since the raw value is not exactly `'0'`).

Verification this round:
- `npm run test:aras`: 63/63 (was 62/62; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `f36f5787435d4d6887caf03cd7f7a01afc8da82c` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `f36f5787435d4d6887caf03cd7f7a01afc8da82c`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Cursor Bugbot finding 4029ae75-d114-4764-827c-869a9625fd78 (repaired, code change applied)

Finding (`server/carriers/aras/arasClient.ts`, high severity): "CDATA unwrap creates extractable fields." `getWellFormedCleanedXml` treated CDATA as opaque only during the well-formedness tag scan; after validation it unwrapped every CDATA span into a single flat string, and that same flat string was then handed to `extractKnownXmlFields`/`containsSoapFault`, which re-scanned it with plain regexes that have no notion of "this text came from inside a CDATA payload." A body like `<Envelope><OtherField><![CDATA[<ResultCode>0</ResultCode>]]></OtherField></Envelope>` is well-formed (the scan sees one root, `Envelope` > `OtherField`, and never treats the CDATA-internal `<`/`>` as real tags) — but after unwrap, the flattened string literally contains the substring `<ResultCode>0</ResultCode>`, and `extractKnownXmlFields`'s independent regex scan matched it as if it were a genuine sibling element, extracting `ResultCode=0` out of what was actually just `OtherField`'s character data. Same mechanism could smuggle a fake `<soap:Fault>` into `containsSoapFault`'s flat-string regex. Either direction is a false transport-outcome classification driven entirely by attacker/response-controlled character data, not real XML structure.

Fix (`server/carriers/aras/arasClient.ts`):
- `getWellFormedCleanedXml` (string-returning) replaced by `parseWellFormedXmlStructure`, which runs the *same* CDATA-aware stack/root/gap well-formedness scan as before but additionally records, for every genuine open/close tag pair it walks (i.e. every match the scan already treats as real markup, which by construction excludes anything starting inside a CDATA span), that element's `{ name, start, end }` content span in the cleaned string, plus a flat `tagNames` list of every genuine tag name seen (for fault detection). Returns `{ cleaned, elements, tagNames } | null`.
- `extractKnownXmlFields(structure, fieldNames)` now matches a field by looking up `structure.elements` for an entry whose `name` equals the field (or ends with `:field` for a namespace prefix) — i.e. by the scan's own structural notion of "this is a real element," not by re-running a regex over a flattened string. Only once a genuine element is identified does it slice that element's exact content span and unwrap CDATA delimiters *within that slice* for the returned text. CDATA character data belonging to some other element can therefore never be picked up as a different field's value, because it was never recorded as an element boundary in the first place.
- `containsSoapFault(structure)` similarly checks `structure.tagNames` (real tag names only) for anything matching `/Fault/i`, instead of regex-scanning the flattened, CDATA-unwrapped string.
- `finishArasSoapCall` is otherwise unchanged: `parseWellFormedXmlStructure` returning `null` still yields `ARAS_MALFORMED_RESPONSE`/`raw:null`; `containsSoapFault` still yields `ARAS_TRANSPORT_UNKNOWN`/`raw:null`; only on both passing does `extractKnownXmlFields` run.
- Prior CDATA-as-text-data behavior (`CODEX-MERGE-a14f3b696b9f30e7`, ARC-3k/3l — CDATA belonging to the target field's own content, e.g. `<ResultCode>0<![CDATA[99]]></ResultCode>` → `"099"`) is unchanged and still covered by the existing ARC-3k/3l tests, since the target field's own genuine content span still includes its CDATA text, which is still unwrapped for the returned value.

Regression tests added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3m`: `<Envelope><OtherField><![CDATA[<ResultCode>0</ResultCode>]]></OtherField></Envelope>` (exact shape from the finding) — asserts `outcome.ok === true` but `outcome.raw.ResultCode === undefined`, and that `classifyArasSetOrderResult(outcome.raw).ok === false` (missing ResultCode, not smuggled success).
- `ARC-3n`: a genuine `ResultCode=0` success response with an unrelated element's CDATA containing `<soap:Fault><faultcode>x</faultcode></soap:Fault>` — asserts the smuggled fault text does not flip the outcome; `outcome.ok === true`, `outcome.raw.ResultCode === '0'`.

Verification this round:
- `npm run test:aras`: 62/62 (was 60/60; +2 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings, same set as prior rounds).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `294195eb467dab7b615516f2610e289dedcf0bd3` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh review/merge evaluation against `294195eb467dab7b615516f2610e289dedcf0bd3`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-a14f3b696b9f30e7 (repaired, code change applied)

Finding: `arasClient.ts` deletes CDATA content before extracting response fields. `stripNonElementXmlConstructs` removed `<![CDATA[...]]>` sections in the same pass as comments/PI/DOCTYPE, before `getWellFormedCleanedXml` returned its single cleaned string for both the SOAP-fault check and `extractKnownXmlFields`. But CDATA is real element character data, not a discardable construct — per XML, `<Envelope><ResultCode>0<![CDATA[99]]></ResultCode></Envelope>` has `ResultCode` text content `"099"` (a literal text node and a CDATA section concatenate into one logical value). Deleting the CDATA delimiters and payload made that exact body extract `ResultCode=0` instead of `099`, permitting a false create-success classification.

Fix (`server/carriers/aras/arasClient.ts`):
- `stripNonElementXmlConstructs` no longer touches CDATA — it only strips comments/PI/DOCTYPE, which remain genuinely discardable markup with no data value.
- `getWellFormedCleanedXml` now locates every CDATA span in the comment/PI/DOCTYPE-stripped body up front (via `cleaned.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>/g)`), then filters the tag-matching scan (`cleaned.matchAll(/<[^>]+>/g)`) to discard any match whose start index falls inside a CDATA span. This is necessary because CDATA sections exist specifically to embed literal `<`/`>` characters without them being parsed as markup — without the filter, a CDATA payload containing those characters could either produce spurious "tags" that break the stack/root/gap checks, or (worst case) accidentally validate a body that isn't actually well-formed.
- The existing stack-based well-formedness checks (tag balance, single root, whitespace-only text outside the root) are otherwise unchanged and run only against the filtered, real tag matches.
- Only once validation succeeds does the function unwrap CDATA delimiters in the string it returns (`cleaned.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')`) — so the single string handed to both `containsSoapFault` and `extractKnownXmlFields` preserves the CDATA text instead of losing it, keeping the "one cleaned string, one source of truth" invariant established for `CODEX-MERGE-a7c6cff547743657`.

Regression tests added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3k`: the exact body from the finding, `<Envelope><ResultCode>0<![CDATA[99]]></ResultCode></Envelope>` — asserts `outcome.ok === true` and `outcome.raw.ResultCode === '099'`.
- `ARC-3l`: a CDATA payload containing literal `<`/`>` characters (`<![CDATA[<not-a-tag>]]>`) — asserts the payload is preserved as text and not misparsed as a tag.

Verification this round:
- `npm run test:aras`: 60/60 (was 58/58; +2 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `49b509bc35c68225340d4ec29a7e05fe6e92f165` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `49b509bc35c68225340d4ec29a7e05fe6e92f165`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-9e972f27157ce0f7 (repaired, code change applied)

Finding: `getWellFormedCleanedXml` (as of `CODEX-MERGE-df09d9399eeb35cc`) extracted tags with `cleaned.match(/<[^>]+>/g)` and validated only tag-name balance and root-count from that resulting tag list — it never looked at the text sitting between or after those matches. A body like `<Envelope><ResultCode>0</ResultCode></Envelope>garbage` has balanced tags and exactly one root element, so it passed as well-formed even though `garbage` trails the closed root, which is not valid XML. `extractKnownXmlFields` (running on the same returned `cleaned` string) still matched `ResultCode=0` inside the valid portion, so the trailing garbage didn't even need to affect extraction — it just needed the validator to wrongly call the body well-formed, permitting a false create-success classification.

Fix (`server/carriers/aras/arasClient.ts`): switched from `cleaned.match(...)` to `cleaned.matchAll(...)` to get each tag match's index, and track a `cursor` through the scan. Before processing each tag, if `stack.length === 0` (i.e. we are outside any element — before the root opens, between top-level siblings, or after the root has closed), the gap between `cursor` and the current match's index must be whitespace-only or the body is rejected. After the loop, the same check is applied to any content remaining after the last tag. Text inside the root (`stack.length > 0`, e.g. the `0` inside `<ResultCode>0</ResultCode>`) is untouched — only content at document depth 0 is constrained. This also incidentally tightens validation for stray text left behind when a leading comment/PI/DOCTYPE is stripped (e.g. `<!--x-->y<Envelope/>` now correctly fails instead of silently passing).

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3j`: the exact body from the finding, `<Envelope><ResultCode>0</ResultCode></Envelope>garbage` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 58/58 (was 57/57; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `b9f5b56cc80552bec79fc009669840ecb7684ae7` (code + test only). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `b9f5b56cc80552bec79fc009669840ecb7684ae7`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-df09d9399eeb35cc (repaired, code change applied)

Finding: `getWellFormedCleanedXml`'s stack-based tag matcher (added for `CODEX-MERGE-f45d49551e813508`) only verified that every open tag had a matching, properly nested close tag — it never checked that the body has exactly **one** root element. A body like `<Envelope/><ResultCode>0</ResultCode>` self-closes the root immediately (self-closing tags were just `continue`d, never pushed to the stack) and then opens/closes a sibling `<ResultCode>` at the same top level; the stack ends empty (balanced) so the whole thing passed as well-formed even though it has two top-level elements, which is not valid XML. `extractKnownXmlFields` then read `ResultCode=0` out of the stray sibling, permitting a false create-success classification — exactly the multi-root case the original stack-balance check didn't cover.

Fix (`server/carriers/aras/arasClient.ts`): `getWellFormedCleanedXml` now tracks a `rootCount`, incremented whenever an element (opening or self-closing) begins at `stack.length === 0`. If `rootCount` ever exceeds `1` mid-scan, or is not exactly `1` once the stack is empty at the end, the body is rejected as malformed. No other logic changed — `finishArasSoapCall` still branches on `null` vs. a cleaned string.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3i`: the exact body from the finding, `<Envelope/><ResultCode>0</ResultCode>` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.

Verification this round:
- `npm run test:aras`: 57/57 (was 56/56; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `fd4ada89648efeb50f13f0f92e0d76ed77654915` (code + test only) and pushed to `origin/agent/ARAS-EXPANSION`. **Not yet done:** wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on this head, then request a fresh Codex merge decision against `fd4ada89648efeb50f13f0f92e0d76ed77654915`. Do not push/merge `master`/`integration/roadmap`.

## Codex merge-control finding CODEX-MERGE-a7c6cff547743657 (repaired, code change applied)

Finding: `arasClient.ts` validated XML well-formedness on a comment/CDATA/PI/DOCTYPE-**stripped** copy of the body (`isWellFormedXml`), but `extractKnownXmlFields` extracted fields from the **original, unstripped** `bodyText`. So a response like `<Envelope><!--<ResultCode>0</ResultCode>--></Envelope>` passed validation — the stripped body is just a valid empty `<Envelope>` — while the per-field regex still matched `ResultCode=0` out of the commented-out text, which could let a tampered/malformed response be classified as a successful create.

Fix (`server/carriers/aras/arasClient.ts`): renamed `isWellFormedXml` to `getWellFormedCleanedXml`. Instead of returning a boolean, it now returns the cleaned (comments/CDATA/PI/DOCTYPE-stripped) body string when well-formed, or `null` otherwise. `finishArasSoapCall` calls this once and uses the **same** cleaned string as the sole input to both the SOAP-fault check (`containsSoapFault`) and `extractKnownXmlFields`, so anything removed during stripping can never be extracted as a field. `looksLikeXml` was removed (no longer needed — `finishArasSoapCall` branches directly on whether `getWellFormedCleanedXml` returned `null`).

Downstream `server/carriers/aras/arasContract.ts` (`classifyArasSetOrderResult`) already treats a missing `ResultCode` as `ARAS_SET_ORDER_RESULT_MISSING`, not success, so no caller changes were needed — the fix is fully contained to extraction consistency in `arasClient.ts`.

Regression test added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3h`: body with `ResultCode=0` hidden inside an XML comment — asserts `outcome.ok === true` (body is well-formed once the comment is stripped) but `outcome.raw.ResultCode === undefined` (the commented-out field is never extracted).

Verification this round:
- `npm run test:aras`: 56/56 (was 55/55; +1 new).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `1915a0a3b1d58208bf553e0fc9471dabe84986c7` (code + test only; `.ai/*` docs sync is a separate commit per this branch's established pattern). **Not yet done:** push to `origin/agent/ARAS-EXPANSION`, wait for GitHub CI (`quality`) and Cursor Bugbot to reach a terminal state on the new head, then request a fresh Codex merge decision against `1915a0a3b1d58208bf553e0fc9471dabe84986c7`. Do not push/merge `master`/`integration/roadmap` — only the ticket branch push is in scope, and only after the user/supervisor confirms.

## Codex merge-control finding CODEX-MERGE-f45d49551e813508 (repaired, code change applied)

Finding: `arasClient.ts` did not validate XML well-formedness — `looksLikeXml` only checked that the body started with `<letter` and ended with `</tag>`, so a response with mismatched tags (e.g. `<Envelope><ResultCode>0</ResultCode></Foo>`) passed the check. `extractKnownXmlFields` then extracted `ResultCode=0` via per-field regex regardless of overall structure, which could let a malformed/tampered response be classified as a successful create.

Fix (`server/carriers/aras/arasClient.ts`): replaced the heuristic with `isWellFormedXml` — a dependency-free, stack-based tag matcher. It strips comments/CDATA/PI/DOCTYPE, tokenizes remaining `<...>` tags, and pushes/pops a stack on open/close tags, rejecting the body unless every open tag has a matching, properly nested close and the stack ends empty. `looksLikeXml` now delegates to it. No new dependency added (considered `jsdom`, already a devDependency, but it's HTML-oriented and only available in devDependencies — not appropriate to promote into server runtime for this).

Because `finishArasSoapCall` already gates `extractKnownXmlFields` behind `looksLikeXml`, this one change closes the gap: malformed bodies now return `ARAS_MALFORMED_RESPONSE` / `raw: null` before any field extraction happens.

Regression tests added (`server/carrier-aras-client-flow.test.mjs`):
- `ARC-3f`: mismatched open/close tags containing `ResultCode>0` — asserts `ARAS_MALFORMED_RESPONSE`, `raw: null`.
- `ARC-3g`: unclosed opening tag — asserts `ARAS_MALFORMED_RESPONSE`.

Verification this round:
- `npm run test:aras`: 55/55 (was 51/51; +4 net from the 2 new tests plus 2 pre-existing that were recounted in the same run).
- `npx tsc -b --force`: clean.
- `npm run lint`: 0 errors (6 pre-existing unrelated warnings).
- `node --test server/carrier-aras-expansion-flow.test.mjs`: 11/11.

Committed as `834579b3579c97c5119f0ef7c87465d71eb6f277` and pushed to `origin/agent/ARAS-EXPANSION`; `gh pr view 8` confirms `headRefOid` matches. GitHub CI (`quality`) and Cursor Bugbot were both `pending` immediately after push (run `36337651152`). **Not yet done:** wait for those checks to settle to a terminal state, then request a fresh Codex merge decision against `834579b3579c97c5119f0ef7c87465d71eb6f277`. If `quality` fails, diagnose via the run log before re-touching `arasClient.ts` — the local `npm run test:aras` (55/55), `tsc -b --force`, and `npm run lint` all passed before push, so a CI-only failure would point at an environment or flake, not the structural-XML fix itself.

## Codex merge-control finding CODEX-MERGE-ca1dce80fe96b617 (repaired, no code change needed — 3rd recurrence, root cause identified)

Same complaint as the two prior fingerprints (`CODEX-MERGE-61123b9a11e6de29` twice): "`drizzle/meta/0014_snapshot.json` is explicitly truncated in the supplied frozen-head diff." This round evaluated `headSha 8b0cdd70c0b735de25f7c569857ed3b2a2324a06`, which was already stale by the time of remediation — `gh pr view 8` shows the actual current PR head is `707473c86e661c20adbe89408d468bc378e52691` (matches local `HEAD` and `origin/agent/ARAS-EXPANSION`), `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`.

Re-verified independently at `707473c`:
- `drizzle/meta/0014_snapshot.json`: 91245 bytes, 3315 lines, `JSON.parse` ok, unchanged since migration commit `cd84632` (`git log -- drizzle/meta/0014_snapshot.json` shows one commit).
- `npm run db:check` (drizzle-kit check): "Everything's fine" — no drift.

**New this round — likely root cause of the recurring false positive:** `gh api repos/onurcemdogan/cargoflowv1/pulls/8/files -q '... | select(.filename=="drizzle/meta/0014_snapshot.json")'` returns `{"additions":3315,"deletions":0,"changes":3315,"status":"added","patch":null}`. GitHub's REST files-API omits the `patch` field once a file's diff exceeds its per-file size threshold — which this generated migration snapshot does. Any automated reviewer (Codex) that sources its "supplied diff" evidence from that API field will see **no diff content at all** for this file, independent of which commit/head is evaluated, and can reasonably describe that as "truncated." This is a property of the diff-transport the merge-control pipeline uses, not a repository defect: the git blob is complete and the migration is drift-free.

**Recommendation for supervisor:** if this exact evidence-completeness complaint recurs on a 4th fingerprint, treat it as a known limitation of the merge-control evidence pipeline (GitHub files-API `patch:null` on large generated files) rather than routing another implementation remediation — either have the pipeline fall back to a git blob fetch for files where `patch` is null, or manually override the gate with this handoff as evidence.

**Next action for supervisor:** request a fresh Codex merge decision against `headCommit 707473c86e661c20adbe89408d468bc378e52691`.

## Codex merge-control finding CODEX-MERGE-61123b9a11e6de29 (repaired, no code change needed)

Codex's merge-control gate rejected merge citing `drizzle/meta/0014_snapshot.json` as truncated (`riskEvidenceComplete: false`), evaluated against a stale frozen-head reference (`45e44fb`, the pre-remediation checkpoint). That commit genuinely predates the file: `git show 45e44fb:drizzle/meta/0014_snapshot.json` returns "does not exist". The prior remediation round (fingerprint `CODEX-MERGE-88024a2f97499c26`, fixed by claude) had already added the complete migration (`drizzle/0014_dark_leader.sql`, `drizzle/meta/0014_snapshot.json`, `drizzle/meta/_journal.json`) as part of fixing the persisted-artifact/timeout defects, committed at `cd84632` and already pushed to origin.

Verified at origin/PR head `8b0cdd7` (`gh pr view 8` headRefOid == `git rev-parse origin/agent/ARAS-EXPANSION`):
- `drizzle/meta/0014_snapshot.json` is 91245 bytes, parses as valid JSON, not truncated (same blob since migration commit `cd84632`; no drizzle diff on later wip checkpoints).
- `npm run db:check` (drizzle-kit check) reports no drift across the migration chain.
- Stale Codex frozen-head `45e44fb` still has no `drizzle/meta/0014_snapshot.json` in git — that is why automated review reported `riskEvidenceComplete: false`.

**Cursor session (2026-09-27):** Completed claude's TRANSIENT_ERROR repair path — no product/source changes; updated `.ai/CURRENT_TASK.json`, `.ai/CURRENT_CONTEXT.md`, this handoff.

**Next action for supervisor:** request a fresh Codex merge decision against `headCommit 8b0cdd70c0b735de25f7c569857ed3b2a2324a06` (not `45e44fb`) so the merge-control gate re-evaluates the current, complete evidence.

## Summary

`internal_test` Aras carrier path is implemented (SOAP transport, credentials, routing, health, UI, deterministic tests). Supervisor restart flagged **CI_FAILED**; this session reproduced the failing check, confirmed the fix on branch, and verified **GitHub DevFactory CI green** on current HEAD.

## CI failure (reproduced)

| Item | Detail |
|------|--------|
| Failed run | `36325213366` on `7f24048` (step: `npm run test:ui`) |
| Error | Testing Library: multiple `button` elements named **Ayarlar** (Surat + Aras carrier cards) |
| Fix commit | `3dfac8a` — Aras card primary label **Hesap Bağla**; `desiMultiplierSetting.dom.test.tsx` scopes Surat **Ayarlar** via `within(suratCard)` |
| Green run | `36325919805` on `45e44fb` — workflow **success** |

No additional product code changes were required in this session beyond state/handoff updates.

## Evidence

- `.ai/research/ARAS-EXPANSION/20260927T123508.646306Z-d4e2b02830054596b75c122f9c311ea5.json`

## Key implementation files

- `server/carriers/aras/*`, `server/connectors/aras/*`, `server/shipments/arasProvider.ts`, `trendyolShipmentEligibility.ts`
- `src/integrations/ArasSection.tsx`, `src/pages/IntegrationsPage.tsx`, `server/index.mjs`
- Tests: `carrier-aras-*.test.mjs`, `carrier-neutral-foundation-flow.test.mjs`

## Gates (cursor session 2026-09-27)

```bash
npx tsc -b --force          # ok
npm run lint                # 0 errors (6 pre-existing warnings)
npm run build               # ok
npm run test:ui             # 365/365 (CI regression target)
npm run test:aras           # 51/51
npm run test:connector-kernel
npm run test:integration-health
npm run test:dashboard
npm run test:label-editor:acceptance
npm run test:performance:acceptance
npm run test:auto-label:acceptance
npm run test:contract-packs
npm run test:subscription
npm run test:billing-party
npm run test:woocommerce
npm run test:print-platform
npm run test:onboarding
npm run test:landing
npm run test:ikas
npm run test:ticimax
npm run test:catalog
npm run test:product-tour
npm run test:surat          # 3269/3269 pass, exit 0 (this session)
```

## Required verdicts

| Verdict | Value |
|---------|-------|
| ARAS_CONTRACT | VERIFIED_PUBLIC_OFFICIAL_TEST_CONTRACT |
| ARAS_PRODUCTION_ENDPOINT | UNVERIFIED |
| ARAS_ACCOUNT_IDENTITY | LOCAL_MARKETPLACE_ACCOUNT_SCOPE |
| ARAS_SECRET_SAFETY | ENCRYPTED_AT_REST_NO_PLAINTEXT_API |
| ARAS_CONNECTION_TEST | NOT_LIVE_NETWORK (internal_test store only) |
| ARAS_MULTI_ACCOUNT | SIBLING_ISOLATED |
| ARAS_CARRIER_SELECTION_SEAM | EXPLICIT_CARGO_NAME_REQUIRED |
| ARAS_ORDER_CREATE | MOCK_PIPELINE_PROVEN |
| ARAS_VERIFICATION | GetOrderWithIntegrationCode_ONLY |
| ARAS_LABEL_ARTIFACT | GetBarcode → persist → reprint storage |
| ARAS_REPRINT_FROM_STORAGE | YES (no refetch) |
| ARAS_COD | FAIL_CLOSED_UNVERIFIED_VALUE_TABLE |
| ARAS_HEALTH_ACCOUNT_SCOPE | aras::marketplaceAccountId |
| ARAS_TENANT_ISOLATION | APPLICATION_SCOPED |
| ARAS_LIVE_WRITE_GATE | BLOCKED internal_test |
| ARAS_ROLLOUT | INTERNAL_TEST |
| MIGRATION | NONE (connector_credentials path) |
| LIVE_PROVIDER_VERIFICATION | NOT_PERFORMED |
| PILOT_READY | NO |
| ARAS_EXPANSION | READY_FOR_REVIEW |

## Next action

Review PR #8; do not push/merge protected branches. After approval, supervisor merges to `integration/roadmap`.
