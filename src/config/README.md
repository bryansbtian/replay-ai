# config

The only module that reads `process.env`. Validates the environment with Zod and
hands the rest of the system a typed, readonly `AppConfig`. This deployment has no
model credential: the local runtime needs none. `toSafeConfig` is the projection that
is safe to log.
