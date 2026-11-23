-- Runs once, when the Postgres volume is first created.
-- devlens: dashboard data. devlens_test: wiped by dashboard tests. demo: the sample app's own data.
CREATE DATABASE devlens;
CREATE DATABASE devlens_test;
CREATE DATABASE demo;
