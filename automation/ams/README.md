# AMS daily updater

Runs Kinexon and Firstbeat once daily at 11:45 p.m. America/Chicago, plus a validation run when updater code changes. It calls the existing AMS importer and independently checks saved records, roster matches, counts and timestamps. No AI calls, athlete data files or provider credentials are stored here. Console logs contain aggregate counts only.

The imports run independently. A provider cooldown is respected within the daily job; incomplete imports fail visibly and keep saved history. Public-repository schedule inactivity is prevented by a timestamp-only maintenance commit at most once every 28 days. Manual runs are available in Actions.

Staff continue using the same AMS dashboards. Force-plate and other separate-source tabs retain their existing sources. Coach-ready Gmail progression emails were retired at the user's request on November 6, 2026. The ChatGPT email task is disabled. Daily data imports continue through this GitHub workflow without AI calls or email reports.
