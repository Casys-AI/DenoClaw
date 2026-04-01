# Security Policy

## Supported Scope

DenoClaw is under active development. Security reports should target the latest
state of `main` unless the report is about a historical release.

## Reporting a Vulnerability

Please do not open public GitHub issues for suspected vulnerabilities.

Report security issues privately to:

- `erpesle@gmail.com`

Include:

- Affected component or file path
- Clear reproduction steps or proof of concept
- Impact assessment
- Any configuration or deployment assumptions required to reproduce the issue

## Response Expectations

- I will acknowledge receipt as quickly as practical.
- I may ask follow-up questions or request a reduced reproduction.
- Once validated, I will work on a fix and decide whether the issue should be
  disclosed immediately or after a patch lands.

## Scope Notes

The following boundaries matter when evaluating impact:

- The broker is the canonical public ingress.
- Agent runtimes are not intended to become public arbitrary-execution
  endpoints.
- Sandbox and subprocess isolation boundaries are security-critical.

Reports that weaken those assumptions are useful and in scope.
