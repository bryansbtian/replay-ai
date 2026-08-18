# config

The only module that reads `process.env`. Validates the environment with Zod and
hands the rest of the system a typed, readonly `AppConfig`. Secrets never leave
this layer except through explicit accessors, and `toSafeConfig` produces the
projection that is safe to log.
