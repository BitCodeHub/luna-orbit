---
name: Hyundai · Dealer onboarding smoke
platform: mobile
mobile_mode: hma
hma_entry: dealer_onboarding_myh.py
hma_args: --smoke --brand hyundai
max_steps_per_intent: 4
---

<!--
This plan delegates to the existing hma_automation Python suite for the
Hyundai-specific page-object operations. Each step references a page-object
method by name (Page.method) — the mobile driver imports it from
~/Code/hma_automation/pages and calls it.

For deeper LLM-driven exploration of a generic mobile app, switch the
driver to "appium" mode and use ref/role-based snapshots like the web flow.
-->

## Steps
1. HomePage.tap_search
2. MapPage.search_for_demo_dealer
3. DealersPage.tap_first_result
4. DealerDetailPage.tap_schedule_service
5. ScheduleServicePage.tap_continue

## Assertions
- The schedule service screen reached the Continue step without throwing
