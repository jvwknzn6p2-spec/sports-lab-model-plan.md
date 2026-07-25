"""League-isolated profiles, datasets, model pipelines and artifacts.

MLB and NPB share ingestion/storage/domain interfaces but keep **separate** feature
schemas, model artifacts, calibrators, thresholds, settlement/tie rules and
evaluation. Cross-league use is rejected (see :mod:`handiedge.leagues.artifacts`).
"""
