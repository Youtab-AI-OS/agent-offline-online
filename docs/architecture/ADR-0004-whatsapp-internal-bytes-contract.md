# ADR 0004: Internal WhatsApp attachment content authority

Status: Owner accepted the safe internal contract on 2026-10-06;
source implemented and scoped reviewed; full qualification pending. Related: ADR-0001 and the common
Runtime delivery in ADR-0002. Source implementation has scoped review; full release qualification remains pending.

## Context

The authenticated local WhatsApp bridge previously selected a host pathname
from a send-media request and read that file. Existing bearer and local-host
checks prevent describing this as an unauthenticated public file reader;
they do not constrain an authenticated caller's pathname authority.

The Runtime's existing validate_media_delivery_path policy supports attachments
from ordinary workspaces, protects credential/system paths and preserves the
operator's explicit strict-mode roots and recency contract. The inbound cache
allowlist is a separate policy and cannot replace outbound authorization.

## Decision

The Runtime authorizes the outgoing attachment and reads the authorized object
using a descriptor-bound regular-file read. It sends attachment content and
validated display metadata through a versioned internal media contract. The
bridge must not open a caller-selected host pathname, including on fallback.
Both existing adapter entrypoints must use the same authorization boundary.

The reviewed wire contract uses application/vnd.youtab.whatsapp-media.v1:
a four-byte big-endian UTF-8 metadata length, at most 65,536 metadata bytes,
then the exact declared attachment bytes. Metadata contains contract/version,
chatId, byteLength, attachmentName, mediaType and optional caption/fileName.
No pathname, URL, codec option or caller-supplied thumbnail is accepted.
YOUTAB_AGENT_WHATSAPP_MEDIA_MAX_BYTES defaults to 128 MiB and accepts an
explicit positive decimal limit up to 512 MiB. Invalid configuration fails
closed. This is a new outbound resource limit, not a pre-existing restriction.
Both callers and the bridge must agree on the version and limit. Runtime
streams a validated descriptor; the bridge admits one bounded request before
collecting bytes and holds its permit until actual downstream work settles,
including after a user-visible timeout. Extra requests receive an explicit
busy response. Workspace authorization remains the existing policy.

FFmpeg GIF/voice/video conversion consumes authorized bytes through bounded pipes
with explicit input/output formats and a pipe-only protocol allowlist. It does
not create conversion pathnames or open unrelated host files/external protocol
resources. Input/output bounds, child lifetime and failure fallback must be
tested with the real codec, not only mocked argument assertions.
Image thumbnails use recognized JPEG/PNG/WebP/GIF buffers through Sharp with
explicit input pixel and output byte bounds. Sharp's in-process work is not
claimed to have the FFmpeg subprocess deadline or process isolation.
Preserve captions and fallback, force-document behavior, filename/media type,
authentication, response shape and delivery tracking.

The locked Baileys library can create plaintext temporary files for newsletter
uploads and can invoke its own media decoder. The integration must supply
internally derived thumbnails and audio metadata where supported, and use a
single owned private temporary namespace established before library imports.
On Windows the managed launcher supplies a verified owner-private directory;
the bridge verifies ownership/access controls and rejects an unverified manual
launch. On POSIX the directory is owner-only. Cleanup is identity-bound and
waits for actual pending operations. This protects authorized attachment
bytes; it is not a claim that the entire library never writes to disk or that
a local administrator cannot inspect process data.

The Python caller and Node bridge ship together in the single common Runtime
package. This contract is independent of PC/laptop identity or release channel.
The Phase 1 Windows Setup acquires the pinned FFmpeg 9.0.2 producer archive
directly during its existing online dependency stage. It verifies the archive
SHA-256 and the exact executable, original license and README before atomic
promotion into the staged Runtime. It makes no global PATH change. Managed
launchers resolve and verify the installed executable; an invalid or missing
component in an artifact installation fails explicitly. Source installations
retain their separately configured codec behavior. The release ZIP contains
the acquisition code and a scalar serialized dependency descriptor, preserving
older About metadata comparison. It does not redistribute the producer binary.
This is not Offline/Air-gap qualification or a source-license compliance claim;
prebuilt redistribution and corresponding-source closure remain separately
qualified Phase 2 work. The codec surface uses a 41,943,040 pixel input limit,
bounded subprocess pipes/deadline, and actual format recognition before Sharp.
Independently developed direct bridge clients must migrate; old pathname-only
requests receive an explicit unsupported-contract error. There is no unchecked
pathname compatibility fallback.

## Qualification and rollback

Test both real Runtime caller seams with synthetic allowed and denied files,
missing files, size boundaries, replacement/link races and caption/media
behavior. Test the actual loopback route's authentication, pathname rejection,
content validation, conversion isolation and owned cleanup without a real
WhatsApp account. Preserve the unchanged full security, OWASP, Smoke, pinned
Semgrep and independent exact-source review requirements.

No real service sends, package publication or device upgrade follows from this
ADR. A failure before qualification leaves the release unqualified. Reverting
this tranche is a source rollback requiring renewed review and full gates; it
must not silently restore arbitrary-path authority in a published package.
