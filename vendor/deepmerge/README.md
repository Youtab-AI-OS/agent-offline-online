# deepmerge security patch

This directory vendors `deepmerge` 4.3.1 with the upstream fix for
CVE-2026-93753. The only runtime change rejects `__proto__` in both object
copy loops.

Upstream fix: `d0256cde79edba0c8e10a888ac439124318b14ca`.

Remove this local dependency pin after npm publishes an upstream patched
version.
