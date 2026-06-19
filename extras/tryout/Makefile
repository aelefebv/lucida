# Thin convenience wrapper around the tryout harness. The direct
# `python3 extras/tryout/tryout.py ...` invocation is the contract; this just
# saves typing for humans. Override OUT / FIXTURE / PYTHON on the command line.
#
#   make -C extras/tryout up                       # bring up + tear down (JSON)
#   make -C extras/tryout up FIXTURE=/data/x.ome.zarr
#   make -C extras/tryout up OUT=/tmp/mine
#   make -C extras/tryout drive FIXTURE=/data/x.ome.zarr   # exercise surfaces + capture
#   make -C extras/tryout drive SURFACE=cli FIXTURE=…      # one surface only
#   make -C extras/tryout report FIXTURE=/data/x.ome.zarr  # full run -> report.html + report.md
#
# Set LUCIDA_TRYOUT_SERVER_BIN to a prebuilt server to skip the cargo build,
# LUCIDA_TRYOUT_CLI to a prebuilt CLI to skip the CLI build, and
# LUCIDA_TRYOUT_WEB_DIST to a prebuilt lucida-web/dist for the web surface.

PYTHON  ?= python3
HERE    := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
OUT     ?= /tmp/lucida-tryout
FIXTURE ?=
SURFACE ?= all

FIXTURE_ARG := $(if $(strip $(FIXTURE)),--fixture $(FIXTURE),)
# `report` defaults OUT to the harness's gitignored .tmp/tryout/<ts>/ (omit --out)
# unless the caller overrode OUT on the command line.
REPORT_OUT_ARG := $(if $(filter-out /tmp/lucida-tryout,$(OUT)),--out $(OUT),)

.PHONY: up up-human drive drive-human report report-human help

help:
	@$(PYTHON) $(HERE)tryout.py --help

up:  ## Bring up a live lucida, print JSON, tear it down
	@$(PYTHON) $(HERE)tryout.py up --once --json --out $(OUT) $(FIXTURE_ARG)

up-human:  ## Same, but human-readable summary
	@$(PYTHON) $(HERE)tryout.py up --once --out $(OUT) $(FIXTURE_ARG)

drive:  ## Bring up, exercise CLI + Python + web surfaces, capture, tear down (JSON)
	@$(PYTHON) $(HERE)tryout.py drive --surface $(SURFACE) --json --out $(OUT) $(FIXTURE_ARG)

drive-human:  ## Same, but human-readable summary
	@$(PYTHON) $(HERE)tryout.py drive --surface $(SURFACE) --out $(OUT) $(FIXTURE_ARG)

report:  ## Run every surface and emit report.html + report.md (JSON; default OUT -> gitignored .tmp/tryout/<ts>/)
	@$(PYTHON) $(HERE)tryout.py report --json $(REPORT_OUT_ARG) $(FIXTURE_ARG)

report-human:  ## Same, but human-readable summary
	@$(PYTHON) $(HERE)tryout.py report $(REPORT_OUT_ARG) $(FIXTURE_ARG)
