import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "autonomy" / "lib"))
import outcome_contract as oc


def contract():
    return {"schema": oc.SCHEMA, "id": "upgrade-1", "intent": "Upgrade safely",
            "acceptance": ["Tests pass"],
            "executor": {"id": "agent-a", "kind": "agent"},
            "verifier": {"id": "service-b", "kind": "service"}}


class OutcomeContractTests(unittest.TestCase):
    def test_digest_is_deterministic(self):
        first = contract()
        second = dict(reversed(list(first.items())))
        self.assertEqual(oc.digest(first), oc.digest(second))

    def test_failure_has_json_path(self):
        value = contract()
        value["acceptance"] = [""]
        with self.assertRaisesRegex(oc.ContractValidationError,
                                    r"\$\.acceptance\[0\]"):
            oc.validate(value)

    def test_parties_must_be_independent(self):
        value = contract()
        value["verifier"]["id"] = "agent-a"
        with self.assertRaisesRegex(oc.ContractValidationError, r"\$\.verifier\.id"):
            oc.validate(value)

    def test_typed_economic_and_deployment_boundaries(self):
        cases = [
            ("risk", {"level": "extreme"}, r"\$\.risk\.level"),
            ("budget", {"max_amount": "10", "currency": "USD"},
             r"\$\.budget\.max_amount"),
            ("deployment", {"environment": "prod", "approval_required": "yes"},
             r"\$\.deployment\.approval_required"),
            ("rollback", {"required": 1, "strategy": "revert"},
             r"\$\.rollback\.required"),
            ("dispute", {"process": 42}, r"\$\.dispute\.process"),
        ]
        for field, invalid, path in cases:
            with self.subTest(field=field):
                value = contract()
                value[field] = invalid
                with self.assertRaisesRegex(oc.ContractValidationError, path):
                    oc.validate(value)


if __name__ == "__main__":
    unittest.main()
