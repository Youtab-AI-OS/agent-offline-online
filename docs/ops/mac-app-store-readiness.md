# Mac App Store readiness

The current desktop release is for direct distribution. Do not upload its DMG
or app bundle to App Store Connect.

## Verified on 2026-11-01

- The customer DMG contains a `Developer ID Application` signed app. Its
  entitlements do not include `com.apple.security.app-sandbox`.
- `apps/desktop/package.json` builds macOS `dmg` and `zip` targets. There is no
  `mas` target, MAS provisioning profile, or MAS entitlement set in this repo.
- The app bundles `scripts/install.sh` and its first-launch bootstrap runs it
  through `bash` to install the runtime under `~/.youtab-agent-runtime`.
- The desktop and backend have independent install/update flows, including a
  macOS app replacement script. A Store build cannot replace itself this way.
- The local agent can install skills and other code after review. This needs a
  product and App Review assessment against sections 2.4.5(iv) and 2.5.2 of
  the App Review Guidelines before a Store build is submitted.
- An `Apple Distribution` identity is available on the build Mac. A matching
  App Store provisioning profile and a Store submission package are not yet
  available.

## Required work before submission

1. Preserve local execution with optional server and cloud-model connections.
   Embed the reviewed runtime and its helper executables in the app bundle,
   sign them for sandbox inheritance, and keep mutable state inside the app
   container. Do not run the existing network bootstrap installer.
2. Inventory every post-install code path (skills, plugins, package managers,
   model providers, shell tools). Either include the functionality in the
   reviewed bundle or obtain a documented basis under Apple's executable-code
   rules. Keep cloud-model access available without letting it install code.
3. Make all file access and subprocess behavior work inside App Sandbox. Use
   user-selected file permissions and security-scoped bookmarks where needed.
4. Disable the first-launch installer, self-update, and app-swap flows in the
   Store variant. Apple must distribute app updates.
5. Add separate MAS entitlements, bundle configuration, provisioning profile,
   and `mas-dev`/`mas` build targets. Do not reuse Developer ID signing.
6. Build and launch a `mas-dev` app on a clean macOS account. Test onboarding,
   chat, screenshot save, permissions, files, updates, and quit/relaunch under
   the sandbox. Resolve all sandbox denial logs.
7. Produce the signed Store package, validate it, and upload to App Store
   Connect only after the owner approves the final submission.

The inline screenshot preview change is independent of this migration and can
ship in the existing direct-distribution build.
