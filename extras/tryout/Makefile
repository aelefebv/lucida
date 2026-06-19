# Thin convenience wrapper around the tryout harness. The direct
# `python3 extras/tryout/tryout.py ...` invocation is the contract; this just
# saves typing for humans. Override OUT / FIXTURE / PYTHON on the command line.
#
#   make -C extras/tryout up                       # bring up + tear down (JSON)
#   make -C extras/tryout up FIXTURE=/data/x.ome.zarr
#   make -C extras/tryout up OUT=/tmp/mine
#
# Set LUCIDA_TRYOUT_SERVER_BIN to a prebuilt server to skip the cargo build.

PYTHON  ?= python3
HERE    := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
OUT     ?= /tmp/lucida-tryout
FIXTURE ?=

FIXTURE_ARG := $(if $(strip $(FIXTURE)),--fixture $(FIXTURE),)

.PHONY: up up-human help

help:
	@$(PYTHON) $(HERE)tryout.py --help

up:  ## Bring up a live lucida, print JSON, tear it down
	@$(PYTHON) $(HERE)tryout.py up --once --json --out $(OUT) $(FIXTURE_ARG)

up-human:  ## Same, but human-readable summary
	@$(PYTHON) $(HERE)tryout.py up --once --out $(OUT) $(FIXTURE_ARG)
