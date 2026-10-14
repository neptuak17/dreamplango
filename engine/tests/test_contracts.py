from dpg_audit.contracts import bundle_schema


def test_schema_keeps_field_names_and_model_titles():
    schema = bundle_schema()
    defs = schema["$defs"]
    assert defs["DailySection"]["title"] == "DailySection"
    assert "title" in defs["DailySection"]["properties"]  # the field called `title` survives
    assert "title" not in defs["DailySection"]["properties"]["from_m"]


def test_tuples_use_items_arrays_and_all_fields_are_required():
    defs = bundle_schema()["$defs"]
    start = defs["Component"]["properties"]["start"]
    assert "prefixItems" not in start
    assert len(start["items"]) == 2 and start["minItems"] == start["maxItems"] == 2
    assert set(defs["Finding"]["required"]) >= {"position", "evidence"}
