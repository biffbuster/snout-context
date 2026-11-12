# profiles

Profile records as the users table stores them, and the exports built from them.

- `loadProfile(record)` turns a stored record into `{ id, name }`.
- `saveProfile(profile)` turns a profile back into a record to store.
- `legacyExport(profiles)` writes the nightly CSV the payroll vendor imports.

    npm test
