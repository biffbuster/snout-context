# notifier

`notify(user, message)` sends a message to a user and returns the ids of the messages sent. The email
and SMS providers in `src/` are the sandbox doubles of the real ones, with the same rules.

    npm test
