"""Exercise the actual Hermes API runtime factory while forbidding real agents."""

import json
import os
from pathlib import Path
import socket
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch


def main():
    native_root = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(native_root))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    with TemporaryDirectory(prefix="hermes-native-runtime-smoke-") as directory:
        root = Path(directory).resolve()
        default = root / "default"
        default.mkdir()
        os.environ["HERMES_HOME"] = str(default)

        def deny_network(event, args):
            if event == "socket.connect" and args[0].family in {socket.AF_INET, socket.AF_INET6}:
                raise AssertionError("Native runtime capture must not access the network")
        sys.addaudithook(deny_network)
        from gateway.config import PlatformConfig
        from gateway.platforms.api_server import APIServerAdapter
        from gateway.run import GatewayRunner
        from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
        from hermes_mobile_delivery.compression import _api_runtime
        import run_agent

        api = APIServerAdapter(PlatformConfig(extra={"model_name": "virtual-model"}))
        entry = SimpleNamespace(session_id="mobile_runtime", session_key="mobile_runtime")
        context = SimpleNamespace(api=api, entry=entry, row={})

        def runtime(provider=None, **kwargs):
            return {"provider": provider or f"{Path(get_hermes_home()).name}-provider",
                    "api_key": "fixture-only-not-a-real-key", "api_mode": "chat_completions",
                    "base_url": "https://example.invalid/v1"}

        # Only credential acquisition is stubbed. The real API factory,
        # effective lock parser, model selection and config readers run.
        with patch("run_agent.AIAgent", side_effect=AssertionError("Real AIAgent construction is forbidden")) as constructor, \
                patch("gateway.run._resolve_runtime_agent_kwargs", side_effect=runtime), \
                patch("gateway.run._resolve_runtime_agent_kwargs_for_provider", side_effect=runtime), \
                patch("gateway.platforms.api_server._resolve_request_runtime_agent_kwargs", side_effect=runtime), \
                patch.object(GatewayRunner, "_load_fallback_model", return_value=None):
            for profile in ("default", "work"):
                home = default if profile == "default" else root / "profiles" / profile
                home.mkdir(parents=True, exist_ok=True)
                (home / "config.yaml").write_text(
                    f"model:\n  default: {profile}-global-model\n  provider: {profile}-provider\n")
                token = set_hermes_home_override(home)
                try:
                    with patch.object(api, "_session_model_override_for", return_value=None):
                        context.row = {}
                        model, selected = _api_runtime(context)
                        assert model == f"{profile}-global-model", (profile, model)
                        assert selected["provider"] == f"{profile}-provider", (profile, selected["provider"])
                        context.row = {"model": f"{profile}-stored-model"}
                        model, _ = _api_runtime(context)
                        assert model == f"{profile}-stored-model", (profile, model)
                    override = {"model": f"{profile}-override-model", "provider": "override-provider"}
                    with patch.object(api, "_session_model_override_for", return_value=override):
                        model, selected = _api_runtime(context)
                        assert model == override["model"], (profile, model)
                        assert selected["provider"] == "override-provider"
                        context.row["model_config"] = json.dumps({"browser_model_lock": {
                            "confirmed": True, "model": f"{profile}-locked-model", "provider": "locked-provider"}})
                        model, selected = _api_runtime(context)
                        assert model == f"{profile}-locked-model", (profile, model)
                        assert selected["provider"] == "locked-provider"
                    assert run_agent.AIAgent is constructor
                    print(f"PASS: {profile} global/stored/override/confirmed-lock native precedence; no AIAgent constructed")
                finally:
                    reset_hermes_home_override(token)
            constructor.assert_not_called()
        for db in getattr(api, "_session_dbs", {}).values():
            db.close()


if __name__ == "__main__":
    main()
