# Thin convenience wrapper around the tryout harness. The direct
# `python3 extras/tryout/tryout.py ...` invocation is the contract; this just
# saves typing for humans. Override OUT / FIXTURE / PYTHON on the command line.
#
#   make -C extras/tryout up                       # bring up + tear down (JSON)
#   make -C extras/tryout up FIXTURE=/data/x.ome.zarr
#   make -C extras/tryout up OUT=/tmp/mine
#   make -C extras/tryout drive FIXTURE=/data/x.ome.zarr   # exercise surfaces + capture
#   make -C extras/tryout drive SURFACE=cli FIXTURE=…      # one surface only
#
# Set LUCIDA_TRYOUT_SERVER_BIN to a prebuilt server to skip the cargo build,
# and LUCIDA_TRYOUT_CLI to a prebuilt CLI to skip the CLI build.

PYTHON  ?= python3
HERE    := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
OUT     ?= /tmp/lucida-tryout
FIXTURE ?=
SURFACE ?= all

FIXTURE_ARG := $(if $(strip $(FIXTURE)),--fixture $(FIXTURE),)

.PHONY: up up-human drive drive-human help

help:
	@$(PYTHON) $(HERE)tryout.py --help

up:  ## Bring up a live lucida, print JSON, tear it down
	@$(PYTHON) $(HERE)tryout.py up --once --json --out $(OUT) $(FIXTURE_ARG)

up-human:  ## Same, but human-readable summary
	@$(PYTHON) $(HERE)tryout.py up --once --out $(OUT) $(FIXTURE_ARG)

drive:  ## Bring up, exercise CLI + Python surfaces, capture, tear down (JSON)
	@$(PYTHON) $(HERE)tryout.py drive --surface $(SURFACE) --json --out $(OUT) $(FIXTURE_ARG)

drive-human:  ## Same, but human-readable summary
	@$(PYTHON) $(HERE)tryout.py drive --surface $(SURFACE) --out $(OUT) $(FIXTURE_ARG)
