"""Performance tooling for Lucida render benchmarking."""

from lucida.perf.benchmark import BenchmarkArgs, BenchmarkReport, run_benchmark
from lucida.perf.fixture import FixtureSpec, create_render_perf_fixture
from lucida.perf.gate import GateThresholds, evaluate_gate

__all__ = [
    "BenchmarkArgs",
    "BenchmarkReport",
    "FixtureSpec",
    "GateThresholds",
    "create_render_perf_fixture",
    "evaluate_gate",
    "run_benchmark",
]
