# logging

Structured JSON logger used across the system. Levels, timestamps, structured
fields, and key-based redaction so a secret cannot be logged by accident.

Depends on nothing. `config` depends on it for the `LogLevel` vocabulary.
