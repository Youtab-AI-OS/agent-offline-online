# Microsoft Edge WebView2 Evergreen Standalone Installer (x64)

- Official source: <https://go.microsoft.com/fwlink/?linkid=2124701> (Microsoft WebView2 x64 standalone download)
- Official guidance: <https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution>
- Retrieved: 2026-10-27
- Build-only file: `MicrosoftEdgeWebView2RuntimeInstallerX64.exe`
- Size: 214,884,560 bytes
- SHA-256: `1C401B327FBC7BB9731B4E350A2194F083CBC3EDE46508D52E1CAE6610A39BEA`
- Windows Authenticode: `Valid`, `Microsoft Corporation`, signer thumbprint `4028CAD637509D4744B17EC5B42AED8D7A31E6AF`

`npm run tauri:build` fetches and verifies these exact bytes on the Windows build machine before Tauri builds the app-target Setup. The large build input is ignored by Git; an absent, changed, or unsigned input fails the build. Rust embeds the pinned bytes into the single Windows x64 Setup EXE and verifies their SHA-256 again before installing WebView2 on a clean host. Customer Setup does not download WebView2 from Microsoft. The online common Setup still downloads the authenticated Youtab Runtime release from its configured Youtab release endpoint. The separate offline Runtime edition has its own delivery and qualification path.

The Tauri `offlineInstaller` configuration covers future MSI/NSIS bundling; the shipped app-target EXE uses the pre-Tauri embedded prerequisite path.
