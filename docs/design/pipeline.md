# Local pipeline

## Source and session boundary
The user browses and logs in normally. Discovery saves a private catalog of courses or subscribed replays without exporting cookies or passwords. The internal lecture worker reads the signed replay URL from the subscription run’s private catalog, parses its JSON `args` declaration without evaluating JavaScript, and uses the same read-only endpoints as the player. Authentication failures remain explicit. A listing link is not itself a replay URL.

The standard student list is the default entry. A configured list URL can override it if an institution requires a different entry or term. For an account bound to multiple institutions, `COURSE_FID` selects the institution during login. Read `djz` and `loginnameenc` from the authenticated page along with its term and role. The list endpoint may return an empty success response when either field is wrong or missing. Use the selected institution error to distinguish an unavailable service from an empty course list.

## Transcript
Preserve platform segments, speaker labels and fractional seconds. Produce JSON, SRT, VTT and Markdown. Raw timestamps and playback-relative timestamps are distinct. Edited videos and nonzero offsets must follow the player's existing timestamp adjustment behavior. Match transcript ranges to each slide occurrence by interval overlap, allowing one segment to overlap more than one occurrence.

When the transcript endpoint succeeds but contains no nonblank text, export PPTX and defer DOCX. Keep the next check time in the existing local or encrypted remote ledger. A check is due 48 hours later and is prioritized before new replays. If the PPTX is already ready for every active destination, an empty recheck ends before downloading video. A request error remains a failure.

## Recording
Choose `speech.videos[].type === 'ppt'` by default. Retain source metadata privately. Download via streaming HTTP into a `.part` file and resume only after validating HTTP range responses and total size. Never treat an HTML login/error document as a video. Probe streams after download. If PPT video has no audio, the transcript remains usable; an optional separate teacher stream can supply audio later.

## Slide extraction
Reuse the MIT `video-slide-extractor` detector for block-based differences and activity masks. Decode low-resolution analysis frames with FFmpeg. Preserve the source resolution on export. Require a stable dwell before accepting a page; select frames away from boundaries. Use temporal median capture to reduce moving cursors where supported by the observed frames. A cursor left stationary cannot be recovered with certainty.

Global duplicate matching is conservative and combines perceptual and pixel differences. Store unique images separately from timeline occurrences: revisiting slide A after slide B must keep the second A occurrence. Do not infer that similar slide layouts contain the same text. Keep ordinary animation states unless a configured short transition can be safely collapsed. Embedded video, scrolling and software demonstrations remain as images when uncertain; no manual filtering step is required.

## Output and review
Only two final files per lecture: a PPTX with one rendered page image per slide, and a DOCX with embedded images followed by the corresponding platform transcript. A repeated page appears once in the deck and groups all its lecture intervals in Word. Each source transcript segment is assigned exactly once using maximum interval overlap, with a nearest-page fallback for gaps. Original JSON/SRT/VTT/Markdown and candidate PNGs remain private intermediate files. JPEG delivery images use 4:4:4 chroma and JFIF/EXIF metadata for Office interoperability.

This reconstructs rendered pages, not the original editable PPT source. The local source recording, signed URLs and transcript content are never included in repository commits. Easy blanks, short transitions and high-confidence duplicates can be removed; ambiguous images stay. Automatic crop is limited to recognizable canvas ratios and falls back to the full image.

## Automation and delivery
The GitHub workflow takes account/password, source and SMTP settings from Secrets. An authenticated request context logs into the official Chaoxing endpoint and discovers published playable replays. For local runs, users can sign in with a browser profile. No speech, language or vision model is required.

Each successful delivery channel is recorded independently. Persistent course selection lives in `data/subscriptions.json` on each user's own `data` branch; IDs are Chaoxing `courseinfoid` values. The discovery summary pairs each course name with its ID and links to the editor for the current Fork. All archive runs use the saved subscription IDs. Encrypted delivery receipts live beside the manifest at `data/delivery-state.enc`, using the existing `Salted__` envelope and optimistic Contents API updates. The old `archive-state/delivery-state.enc` is read as a migration source. Failures to read/decrypt existing state stop work rather than treating it as a first run. The Actions cache contains only an encrypted recovery copy. No plaintext course file goes into an artifact, and signed links and request dumps are removed from error output.

Each channel records an early PPTX receipt separately from the existing final delivery receipt. On final delivery, a channel with an early PPTX receipt only receives DOCX. The existing `built`, `email` and `qq` completion records retain their meaning and continue to suppress completed work.

For `DELIVERY=relay`, encrypt each Office file and its metadata with AES-256-GCM and an independent random nonce before it can enter the artifact. Upload only completed envelopes and record cloud handoff after the upload succeeds. If one attachment fails to stage, preserve the other attachment's successful handoff. On Windows, use read-only GitHub authentication, a fixed repository/branch, and a bound local WeChat conversation. The local ledger records the per-attachment send attempt before contacting WeChat; an uncertain result awaits manual resolution. The relay packs pending files into independent ZIPs under the WeChat upload limit, and marks the member receipts together for each ZIP. Do not retry an ambiguous ZIP without reviewing its members. GitHub handoff, local submission and recipient receipt are distinct states.

## Verification
Use a real replay and inspect rendered PPTX slides and Word pages. Validate the embedded image count and compare the Word text against the assigned platform segments. Synthetic fixtures cover a moving cursor, a short transition, a small text change, and A-B-A revisits.
