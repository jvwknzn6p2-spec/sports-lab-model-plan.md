"""Live OpticOdds connector via the runtime ``external-tool`` (audit category 2, 12).

Credentials are injected by the runtime — this package never reads or exposes an
OpticOdds API key. Calls go through the programmatic ``external-tool call`` argv
interface (no shell interpolation). Empty odds is a normal, typed outcome.
"""
