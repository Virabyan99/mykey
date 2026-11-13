-- Run 3.2 (D-27): an account comes into being only through the operator's
-- bootstrap, run as maintenance (FR-1.01). The API's role loses the rights
-- Session 2 gave it to create users and credential accounts; it keeps reading
-- them, updating the columns of 0003 and deleting what it already may.
REVOKE INSERT ON auth."user", auth.account FROM api_runtime;
