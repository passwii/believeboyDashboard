# C2 Backend Project-Scope Authorization Follow-up

Status: unresolved backend review items. The Warm Ledger page migration preserves the current UI and does not change API permissions. Authentication through the router's `protected` dependency and operator audit logging do not by themselves establish per-project authorization.

## Shipment Management

Source reviewed: `backend/app/api/v1/endpoints/shipment_schedules.py`, `backend/app/services/shipment/schedule.py`, and `backend/app/services/shipment/item.py`.

- `POST /shipment-schedules` accepts `project_id`; the handler calls the service, which checks that the project exists, but neither layer checks that the request operator can access that project.
- `POST /shipment-schedules/import-csv` imports rows by project name. The handler and importer do not receive or check the operator's accessible project IDs.
- `PATCH /shipment-schedules/{schedule_id}` loads by record ID and accepts a target `project_id`; the service checks the record and target project exist but does not authorize the operator against the current or target project.
- `POST /shipment-schedules/{schedule_id}/items/import-csv` validates the CSV shipment number and project name against the selected schedule, then replaces its SKU rows. The route/service do not check operator access to that schedule's project.
- `POST /shipment-schedules/{schedule_id}/costs/calculate` calculates and writes costs by schedule ID without a project-scoped authorization check.
- `DELETE /shipment-schedules/{schedule_id}` has an explicit admin-only gate. It does not apply an additional project-scope check; confirm whether global admin access is intended.

Useful source locations: `shipment_schedules.py:547-585`, `:587-642`, `:644-687`, `:730-795`, `:797-850`; `schedule.py:332-395`, `:844-900`; `item.py:180-237`.

Task 4 source recheck (2026-11-03): the cited handlers remain unchanged. `protected` is applied at the router, but create, import, update, SKU replacement, and cost calculation do not check the operator's project access before mutation. The services resolve projects or schedules by ID/name and validate record data only. Delete does require `is_admin` (`shipment_schedules.py:700-705`), but does not separately check project scope; whether administrators have intended global deletion access still needs a backend decision. No backend permissions were changed by the Warm Ledger page migration.

## SKU Info

Source reviewed: `backend/app/api/v1/endpoints/sku_info.py` and `backend/app/services/data/sku_info/crud.py`.

- The list handler computes `managed_project_ids`, but `list_sku_records` applies that restriction only when `project_name` is empty. Supplying a project-name query uses `ILIKE` without intersecting the result with `managed_project_ids`.
- Create, bulk upsert, and CSV import handlers do not perform an explicit project-access check for the project names in their payloads.
- Record-ID `PATCH`, `DELETE`, and sort-move handlers load or mutate the row by ID and do not check that the operator manages the row's project. The router's `protected` dependency remains in place, but it is not a project-scope check.

Useful source locations: `sku_info.py:195-238`, `:248-322`, `:324-437`; `crud.py:293-320`, `:344-365`.

## Follow-up Decision

Conduct a separate backend authorization review before claiming these routes are project-isolated. Decide whether creation/import must authorize every referenced project, whether record-ID mutations must check the row's current project, how project moves are authorized on update, and whether admins may perform cross-project shipment deletion. Keep the C2 UI rollout from presenting visual hiding or selection controls as a permission fix.
