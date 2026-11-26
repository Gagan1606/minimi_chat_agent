# Staging load profile

Use a disposable staging workspace and dedicated test users only. The profile sends 1,300 sustained/burst/concurrent chat requests and creates workspace conversations. Remove the disposable workspace and users after the run; do not point the script at production or a shared customer workspace. Provider calls may incur cost. The script requires an explicit `MOMOS_LOAD_CONFIRM=staging`, HTTPS non-production URL, workspace ID, and 100 test-user cookie/CSRF pairs. It reports request p95 and errors; compare results with the release targets in `docs/SPEC.md`.
