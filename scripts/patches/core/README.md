# Core patch registry

The core registry is intentionally empty. OpenAI's official Linux package is
the compatibility baseline, and a default build must preserve `app.asar`
byte-for-byte.

Product extensions and measured workarounds belong in disabled-by-default
`linux-features/<id>/` directories. A new core descriptor is allowed only when
the current signed official package cannot pass a mandatory launch/work smoke
test without it; the descriptor must include the reproduction evidence and a
required regression test in the migration tracking record.
