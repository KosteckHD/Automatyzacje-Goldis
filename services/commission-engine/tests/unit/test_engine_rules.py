from decimal import Decimal
import datetime as dt
import unittest

from goldis_commissions.engine import alternative_keys, agent, brand, normalized_number, rate_status, reverse_audit


class EngineRulesTests(unittest.TestCase):
    def test_reverse_audit_describes_the_selected_period(self):
        result = reverse_audit([], [], {}, dt.date(2026, 11, 1), dt.date(2026, 11, 30))
        self.assertIn("2026-11-01–2026-11-30", result["note"])
        self.assertNotIn("01.06", result["note"])

    def test_policy_number_rules_preserve_leading_zeroes(self):
        self.assertEqual(normalized_number("AGRO", "1002N01740628"), "01740628")
        self.assertEqual(normalized_number("COMPENSA", "22014-1849756"), "1849756")
        self.assertEqual(normalized_number("OMINIMO", "OMPLINS260901320547"), "260901320547")
        self.assertEqual(normalized_number("UNIQA", "2026-4054286584"), "4054286584")

    def test_allianz_only_removes_prefix_when_a_dash_exists(self):
        self.assertEqual(normalized_number("ALLIANZ", "440-26-642-26369430"), "26369430")
        self.assertEqual(normalized_number("ALLIANZ", "26068685972"), "26068685972")

    def test_name_and_brand_aliases(self):
        self.assertEqual(agent("BĄCZKOWSKI MACIEJ"), "Maciek")
        self.assertEqual(agent("Cybulska Aleksandra"), "Ola")
        self.assertEqual(brand("DA Direkt", "", "OMPLINS260901320547"), "OMINIMO")

    def test_percent_comparison_uses_decimal_tolerance(self):
        self.assertEqual(rate_status("13,5000005", "13.5"), "ZGODNA")
        self.assertEqual(rate_status("13.51", "13.5"), "BLEDNY_PROCENT")
        self.assertEqual(rate_status(None, Decimal("0")), "BRAK_DANYCH")

    def test_allianz_short_number_is_only_a_candidate(self):
        self.assertIn("68685972", alternative_keys("ALLIANZ", "26068685972"))


if __name__ == "__main__":
    unittest.main()
