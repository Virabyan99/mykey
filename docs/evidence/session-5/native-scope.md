# Native scope of a product-issued machine token (Run 5.4 Task C)

PO-2, FR-1.40, FR-1.45. A token issued through `POST …/credentials` for environment 1a of the local stack, used directly against OpenBao 2.7.2 in its organization's namespace. Written by `tests/integration/machine/native-scope.test.ts`; every denied call has a control with the root token on the same path.

| Call                                                                                  | Machine token | Root control                                     |
| ------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------ |
| `GET kv/data/p/<id>/e/<id>/NATIVE_A`                                                  | 200           | —                                                |
| `GET kv/metadata/p/<id>/e/<id>/?list=true`                                            | 200           | —                                                |
| `GET auth/token/lookup-self`                                                          | 200           | —                                                |
| `POST kv/data/p/<id>/e/<id>/NATIVE_NEW`                                               | 403           | 200                                              |
| `POST kv/data/p/<id>/e/<id>/NATIVE_SCRATCH`                                           | 403           | 200                                              |
| `PATCH kv/data/p/<id>/e/<id>/NATIVE_SCRATCH`                                          | 403           | 200                                              |
| `DELETE kv/data/p/<id>/e/<id>/NATIVE_SCRATCH`                                         | 403           | 204                                              |
| `POST kv/delete/p/<id>/e/<id>/NATIVE_SCRATCH`                                         | 403           | 204                                              |
| `POST kv/undelete/p/<id>/e/<id>/NATIVE_SCRATCH`                                       | 403           | 204                                              |
| `PUT kv/destroy/p/<id>/e/<id>/NATIVE_SCRATCH`                                         | 403           | 204                                              |
| `POST kv/metadata/p/<id>/e/<id>/NATIVE_SCRATCH`                                       | 403           | 204                                              |
| `DELETE kv/metadata/p/<id>/e/<id>/NATIVE_SCRATCH`                                     | 403           | 204                                              |
| `GET kv/data/p/<id>/e/<id>/NATIVE_B`                                                  | 403           | 200                                              |
| `GET kv/metadata/p/<id>/e/<id>/?list=true`                                            | 403           | 200                                              |
| `GET kv/data/p/<id>/e/<id>/NATIVE_C`                                                  | 403           | 200                                              |
| `GET kv/metadata/p/<id>/e/<id>/?list=true`                                            | 403           | 200                                              |
| `GET kv/metadata/p/<id>/?list=true`                                                   | 403           | 200                                              |
| `GET kv/metadata/?list=true`                                                          | 403           | 200                                              |
| `POST auth/token/create`                                                              | 403           | 200                                              |
| `POST auth/token/create-orphan`                                                       | 403           | 200                                              |
| `POST auth/token/create/machine-env-<id>`                                             | 403           | 200                                              |
| `POST auth/token/lookup`                                                              | 403           | 200                                              |
| `POST auth/token/lookup-accessor`                                                     | 403           | 200                                              |
| `POST auth/token/revoke-accessor`                                                     | 403           | 204                                              |
| `POST auth/token/revoke-self`                                                         | 403           | 204                                              |
| `GET sys/policies/acl/machine-env-<id>`                                               | 403           | 200                                              |
| `GET sys/policies/acl?list=true`                                                      | 403           | 200                                              |
| `PUT sys/policies/acl/native-scratch`                                                 | 403           | 204                                              |
| `GET sys/mounts`                                                                      | 403           | 200                                              |
| `GET sys/auth`                                                                        | 403           | 200                                              |
| `GET auth/approle/role/runtime`                                                       | 403           | 200                                              |
| `GET sys/namespaces?list=true`                                                        | 403           | 404                                              |
| `POST sys/capabilities-self`                                                          | 403           | 200                                              |
| `GET identity/entity/id?list=true`                                                    | 403           | 200                                              |
| `POST auth/token/renew-self`                                                          | 403           | expire_time not later afterwards: true           |
| `GET auth/token/lookup-self` (namespace `org-<id>`) — a namespace that does not exist | 404           | —                                                |
| `GET kv/data/p/<id>/e/<id>/NATIVE_A` (namespace `t-<random>`)                         | 403           | —                                                |
| `GET auth/token/lookup-self` (namespace `t-<random>`)                                 | 200           | the record names the token's own namespace: true |
| `GET kv/data/p/<id>/e/<id>/NATIVE_A` (namespace `root`)                               | 403           | —                                                |
| `GET auth/token/lookup-self` (namespace `root`)                                       | 200           | the record names the token's own namespace: true |
| `GET kv/data/<own>/NATIVE_RESIDUAL?version=1` (FR-1.45 residual)                      | 200           | —                                                |
