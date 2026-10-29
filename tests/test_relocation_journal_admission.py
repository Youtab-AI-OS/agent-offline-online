"""Malformed relocation records must not redirect or crash startup."""
from pathlib import Path

import pytest

from youtab_constants import _relocated_process_home


def published_record():
    return {
        "schema": 1,
        "phase": "product-validated",
        "publication": {"phase": "published"},
        "source": r"C:\old-home",
        "target": r"C:\private-home",
    }


@pytest.mark.parametrize("journal", [None, [], "record", 1, True])
def test_non_object_record_does_not_redirect_or_raise(journal):
    assert _relocated_process_home(r"C:\old-home", r"C:\private-home", journal) is None


@pytest.mark.parametrize("schema", [True, False, None, "1", 1.0, 0, 2])
def test_schema_requires_exact_integer_one(schema):
    journal = published_record()
    journal["schema"] = schema
    assert _relocated_process_home(r"C:\old-home", r"C:\private-home", journal) is None


def test_published_exact_schema_preserves_root_and_profile_redirect():
    journal = published_record()
    assert _relocated_process_home(r"C:\old-home", r"C:\private-home", journal) == Path(r"C:\private-home")
    assert _relocated_process_home(r"C:\old-home\profiles\coder", r"C:\private-home", journal) == Path(r"C:\private-home") / "profiles" / "coder"


def test_unpublished_and_unrelated_homes_do_not_redirect():
    journal = published_record()
    journal["publication"]["phase"] = "pending"
    assert _relocated_process_home(r"C:\old-home", r"C:\private-home", journal) is None
    journal = published_record()
    assert _relocated_process_home(r"C:\other-home", r"C:\private-home", journal) is None
