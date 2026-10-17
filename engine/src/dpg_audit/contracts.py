"""Export the bundle data contract as JSON Schema, shaped for TypeScript code generation."""

from typing import Any

from dpg_audit.models import BundleContract

SCHEMA_ID = "https://kilometrica.local/schemas/bundle-v0.schema.json"


_NAME_MAPS = ("properties", "$defs", "patternProperties")


def _walk(node: Any) -> None:
    """Simplify a schema node in place. Keys of name maps (e.g. a field called `title`) are left alone."""
    if isinstance(node, dict):
        # Per-field titles would become one named TS alias per field; model and enum names are restored below.
        node.pop("title", None)
        # Pydantic writes tuples as 2020-12 `prefixItems`; codegen tools understand the older `items: [...]` form.
        if "prefixItems" in node:
            items = node.pop("prefixItems")
            node["items"] = items
            node.setdefault("minItems", len(items))
            node.setdefault("maxItems", len(items))
        for key, value in node.items():
            if key in _NAME_MAPS and isinstance(value, dict):
                for sub in value.values():
                    _walk(sub)
            else:
                _walk(value)
    elif isinstance(node, list):
        for value in node:
            _walk(value)


def bundle_schema() -> dict[str, Any]:
    schema = BundleContract.model_json_schema(mode="serialization")
    titles = {name: d.get("title", name) for name, d in schema.get("$defs", {}).items()}
    root_title = schema.get("title", "BundleContract")
    _walk(schema)
    for name, d in schema.get("$defs", {}).items():
        d["title"] = titles[name]
    schema["title"] = root_title
    schema["$id"] = SCHEMA_ID
    return schema
