# Code Signing Policy

Free code signing on Windows provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This policy applies to the Windows installer (`WiFi-Rainbow_<version>_x64-setup.exe`) and the executable inside it (`wifi-rainbow.exe`) published on the [GitHub Releases](https://github.com/yunnysunny/wifi-rainbow/releases) page of this project.

## How releases are built and signed

- Every release binary is built from the source in this repository by a GitHub Actions workflow ([`.github/workflows/build.yml`](../.github/workflows/build.yml)) on GitHub-hosted runners. No part of the build runs on a maintainer's machine.
- The unsigned installer produced by that workflow is submitted to SignPath.io as a GitHub artifact; SignPath verifies that the artifact originates from this repository and workflow before signing.
- Each signing request is approved manually by an approver listed below.
- The signed installer is then attached to the GitHub Release.

## Team

| Role | Member |
|---|---|
| Author | [yunnysunny](https://github.com/yunnysunny) |
| Reviewer | [yunnysunny](https://github.com/yunnysunny) |
| Approver | [yunnysunny](https://github.com/yunnysunny) |

Authors may modify the source without additional review. Changes from anyone else (pull requests) are reviewed by a reviewer before being merged. Approvers approve each signing request.

All team members use multi-factor authentication for their GitHub and SignPath accounts.

## Privacy policy

WiFi Rainbow does not transfer any information to any system, not even on the user's request. It makes no network connections at all: all data shown comes from the local Windows Native Wifi API, and settings are stored only in the local WebView2 profile. CSV / PNG exports are written to the user's own Downloads folder and are never uploaded anywhere.

The installer does not change any system configuration beyond installing the program for the current user, creating Start menu / desktop shortcuts and registering an uninstaller. Uninstallation is available from Windows "Apps & features" or `uninstall.exe` in the install directory.

## Third-party components

The signed binaries contain only code from this repository plus its open-source Rust dependencies (MIT / Apache-2.0, see `rust/Cargo.lock`). No upstream pre-built binaries are signed under this project's SignPath subscription.

## License

WiFi Rainbow is released under the [MIT License](../LICENSE).
