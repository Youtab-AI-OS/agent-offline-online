"""Domain-intel never retries a failed TLS certificate without verification."""

import importlib.util
import ssl
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


SOURCE = Path(__file__).parents[2] / "optional-skills/research/domain-intel/scripts/domain_intel.py"
spec = importlib.util.spec_from_file_location("domain_intel", SOURCE)
domain_intel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(domain_intel)


class DomainIntelTlsTests(unittest.TestCase):
    def test_invalid_certificate_is_not_retried_without_verification(self):
        context = MagicMock()
        context.wrap_socket.side_effect = ssl.SSLCertVerificationError("invalid certificate")
        with patch.object(domain_intel.ssl, "create_default_context", return_value=context) as create_context:
            with patch.object(domain_intel.socket, "create_connection"):
                result = domain_intel.check_ssl("example.invalid")
        self.assertEqual(result["error"], "TLS certificate verification failed")
        create_context.assert_called_once_with()
        context.wrap_socket.assert_called_once()
        self.assertNotIn("verify_mode", context.__dict__)


if __name__ == "__main__":
    unittest.main()
