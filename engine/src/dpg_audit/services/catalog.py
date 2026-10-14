"""Which OSM tags and Overture categories make a place one of our service types, and of which kind."""

Kind = tuple[str, str]
"""(service id, kind)"""

_FOOD_AMENITY = {
    "restaurant": "restaurant",
    "cafe": "cafe",
    "fast_food": "fast_food",
    "food_court": "fast_food",
    "pub": "bar",
    "bar": "bar",
    "biergarten": "bar",
}
_FOOD_SHOP = {
    "supermarket": "supermarket",
    "convenience": "convenience",
    "general": "convenience",
    "bakery": "bakery",
    "pastry": "bakery",
    "greengrocer": "grocery",
    "deli": "grocery",
    "farm": "grocery",
}
_LODGING = {
    "hotel": "hotel",
    "motel": "hotel",
    "guest_house": "guest_house",
    "hostel": "hostel",
    "camp_site": "campsite",
    "alpine_hut": "hut",
    "wilderness_hut": "hut",
}
_TRAIN_LESS = {"subway", "light_rail", "monorail", "funicular", "miniature"}

# Tag values worth pre-filtering from the corridor extract (osmium tags-filter expressions).
OSM_FILTERS = [
    "nwr/tourism=" + ",".join([*_LODGING, "caravan_site"]),
    "nwr/amenity="
    + ",".join(
        [
            *_FOOD_AMENITY,
            "drinking_water",
            "water_point",
            "fountain",
            "toilets",
            "bicycle_repair_station",
            "vending_machine",
            "pharmacy",
            "atm",
            "bank",
            "hospital",
            "ferry_terminal",
        ]
    ),
    "nwr/shop=" + ",".join(["bicycle", *_FOOD_SHOP]),
    "nwr/healthcare=pharmacy,hospital",
    "nwr/man_made=water_tap,water_well",
    "n/natural=spring",
    "nwr/railway=station,halt",
    "nwr/public_transport=station",
]


def classify_osm(tags: dict[str, str]) -> Kind | None:
    """(service, kind) for an OSM object's tags, or None if it is not a service we track.

    Accommodation wins over food (a hotel with a restaurant is a hotel). Holiday apartments and chalets are left
    out: they rarely take one-night stays, which ECS requires.
    """
    t = tags.get
    tourism, amenity, shop = t("tourism"), t("amenity"), t("shop")
    if t("disused") == "yes" or t("abandoned") == "yes" or t("access") in ("private", "no"):
        return None
    if tourism in _LODGING:
        return "accommodation", _LODGING[tourism]
    if tourism == "caravan_site" and t("tents") == "yes":
        return "accommodation", "campsite"
    if amenity in ("drinking_water", "water_point"):
        return ("water", "tap") if t("drinking_water") != "no" else None
    if t("drinking_water") in ("yes", "treated") and (
        amenity == "fountain" or t("man_made") in ("water_tap", "water_well") or t("natural") == "spring"
    ):
        return "water", "spring" if t("natural") == "spring" else "tap"
    if amenity == "toilets":
        return "toilets", "toilets"
    if amenity == "bicycle_repair_station":
        return "repair_station", "station"
    if amenity == "vending_machine" and "bicycle_tube" in (t("vending") or ""):
        return "repair_station", "vending"
    if shop == "bicycle":
        return "bike_shop", "repair" if t("service:bicycle:repair") == "yes" else "shop"
    if amenity in _FOOD_AMENITY:
        return "food", _FOOD_AMENITY[amenity]
    if shop in _FOOD_SHOP:
        return "food", _FOOD_SHOP[shop]
    if amenity == "pharmacy" or t("healthcare") == "pharmacy":
        return "pharmacy", "pharmacy"
    if amenity == "atm" or (amenity == "bank" and t("atm") == "yes"):
        return "atm", "atm" if amenity == "atm" else "bank"
    if (amenity == "hospital" or t("healthcare") == "hospital") and t("emergency") != "no":
        return "hospital", "hospital"
    if amenity == "ferry_terminal":
        return "station", "ferry_terminal"
    is_rail = t("railway") in ("station", "halt") or (t("public_transport") == "station" and t("train") == "yes")
    if is_rail and t("station") not in _TRAIN_LESS and t("usage") != "tourism" and t("tourism") != "attraction":
        return "station", "rail"
    return None


# Overture places: taxonomy.primary first, then basic_category.
OVERTURE_PRIMARY: dict[str, Kind] = {
    "hotel": ("accommodation", "hotel"),
    "motel": ("accommodation", "hotel"),
    "resort": ("accommodation", "hotel"),
    "beach_resort": ("accommodation", "hotel"),
    "inn": ("accommodation", "guest_house"),
    "bed_and_breakfast": ("accommodation", "guest_house"),
    "guest_house": ("accommodation", "guest_house"),
    "lodge": ("accommodation", "guest_house"),
    "hostel": ("accommodation", "hostel"),
    "campground": ("accommodation", "campsite"),
    "supermarket": ("food", "supermarket"),
    "grocery_store": ("food", "grocery"),
    "produce_store": ("food", "grocery"),
    "organic_grocery_store": ("food", "grocery"),
    "health_food_store": ("food", "grocery"),
    "public_market": ("food", "grocery"),
    "convenience_store": ("food", "convenience"),
    "bakery": ("food", "bakery"),
    "patisserie_cake_shop": ("food", "bakery"),
    "cafe": ("food", "cafe"),
    "coffee_shop": ("food", "cafe"),
    "tea_room": ("food", "cafe"),
    "fast_food_restaurant": ("food", "fast_food"),
    "sandwich_shop": ("food", "fast_food"),
    "food_court": ("food", "fast_food"),
    "delicatessen": ("food", "grocery"),
    "tapas_bar": ("food", "restaurant"),
    "diner": ("food", "restaurant"),
    "bistro": ("food", "restaurant"),
    "gastropub": ("food", "restaurant"),
    "pharmacy": ("pharmacy", "pharmacy"),
    "atm": ("atm", "atm"),
    "bike_store": ("bike_shop", "shop"),
    "bike_repair_maintenance": ("bike_shop", "repair"),
    "hospital": ("hospital", "hospital"),
    "emergency_department": ("hospital", "emergency"),
    "public_restroom": ("toilets", "toilets"),
}
OVERTURE_BASIC: dict[str, Kind] = {
    "restaurant": ("food", "restaurant"),
    "bar": ("food", "bar"),
    "cafe": ("food", "cafe"),
    "coffee_shop": ("food", "cafe"),
    "fast_food_restaurant": ("food", "fast_food"),
    "convenience_store": ("food", "convenience"),
    "hotel": ("accommodation", "hotel"),
    "bed_and_breakfast": ("accommodation", "guest_house"),
    "campground": ("accommodation", "campsite"),
    "pharmacy_and_drug_store": ("pharmacy", "pharmacy"),
    "atm": ("atm", "atm"),
    "hospital": ("hospital", "hospital"),
}
_OVERTURE_SKIP_PRIMARY = {
    "holiday_rental_home",
    "service_apartment",
    "cottage",
    "cabin",
    "drugstore",
    "airport_lounge",
    "hotel_bar",
}


def classify_overture(basic_category: str | None, primary: str | None) -> Kind | None:
    if primary in _OVERTURE_SKIP_PRIMARY:
        return None
    if primary in OVERTURE_PRIMARY:
        return OVERTURE_PRIMARY[primary]
    if basic_category in OVERTURE_BASIC:
        return OVERTURE_BASIC[basic_category]
    if basic_category == "lodging" and primary == "lodging":
        return "accommodation", "other"
    return None


def overture_sql_filter() -> str:
    primaries = sorted(OVERTURE_PRIMARY)
    basics = sorted({*OVERTURE_BASIC, "lodging"})
    quote = ", ".join
    return (
        f"(taxonomy.primary IN ({quote(repr(p) for p in primaries)}) "
        f"OR basic_category IN ({quote(repr(b) for b in basics)}))"
    )
