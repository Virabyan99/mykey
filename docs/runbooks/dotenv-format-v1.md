# MyKey dotenv format v1

This is MyKey dotenv format v1; it does not claim universal dotenv compatibility.

It is the one text format the service accepts on import and writes on export (Document 04 §5: FR-1.33, FR-1.34, FR-1.38). The format is deliberately narrow: anything two dotenv loaders could read differently is rejected on the way in, and the way out has exactly one spelling.

| What                 | Where                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Parser               | `parseDotenv(bytes)` in `packages/contracts/src/dotenv/parse.ts`                         |
| Canonical writer     | `serializeDotenv(entries)` in `packages/contracts/src/dotenv/serialize.ts`               |
| Loader warnings      | `loaderWarnings(entries)` in `packages/contracts/src/dotenv/warnings.ts`                 |
| Unit tests           | `tests/unit/dotenv/` (examples, properties with fast-check, fixtures)                    |
| Fixtures             | `tests/fixtures/dotenv/accepted/` and `rejected/reject.<rule>.<n>.env`                   |
| Loader evidence test | `tests/integration/dotenv-loaders/loaders.test.ts` with `tests/fixtures/dotenv-loaders/` |

All three functions are exported from `@mykey/contracts`.

## Limits

The numbers live in `LIMITS` (`packages/contracts/src/limits.ts`); the parser reads them from there.

| Limit                    | Value                   | `LIMITS` key            | Rule when exceeded |
| ------------------------ | ----------------------- | ----------------------- | ------------------ |
| File size                | 1,048,576 bytes (1 MiB) | `body.dotenvMaxBytes`   | `file_too_large`   |
| Entries in one file      | 1,000                   | `body.dotenvMaxEntries` | `too_many_entries` |
| One value                | 65,536 bytes of UTF-8   | `secret.valueMaxBytes`  | `value_too_large`  |
| One name                 | 128 characters          | `secret.nameMaxLength`  | `invalid_name`     |
| Issues reported per file | 100, then parsing stops | none                    | none               |

The file size is checked before any byte is decoded. A value is measured after its escapes are resolved, so `"\"\""` counts as two bytes, not four.

## Grammar

### Bytes and lines

- The file is UTF-8 without a byte order mark. It is decoded with a fatal decoder: an invalid sequence is an error, never a replacement character.
- A line ends with LF or CRLF. Both may appear in one file. The last line may have no ending.
- A CR that is not directly followed by LF is an error (`lone_cr`), wherever it stands, including at the very end of the file.
- A NUL character is an error (`nul`), wherever it stands.
- An empty file is valid and has no entries.

### Kinds of line

A line is exactly one of:

| Kind    | Shape                  | Meaning                |
| ------- | ---------------------- | ---------------------- |
| Empty   | zero characters        | skipped                |
| Comment | first character is `#` | skipped                |
| Entry   | `NAME=value`           | one name and one value |

Nothing else is a line. In particular, a line that holds only whitespace, a line that starts with whitespace (also before a `#`), and whitespace between the name and `=` are errors (`invalid_line`). There is no `export` prefix (`export_prefix`).

### Names

`NAME` is everything before the first `=`. It must match `^[A-Z][A-Z0-9_]{0,127}$` (`invalid_name`) and must not start with `SECRETS_` (`reserved_name`); both checks are `checkSecretName`. A name may appear once in a file (`duplicate_name`).

### Values

Everything after the first `=` is the value text, so `A=b=c` has the value `b=c`. The value text takes one of three forms.

**Empty.** `A=` is the empty string.

**Unquoted.** The text does not start with a quote.

- It is taken literally, character for character. Interior spaces are kept: `A=two words` is `two words`.
- It must not start or end with whitespace (`unquoted_whitespace`). So `A= x` and `A=x ` are errors, and so is `A= "x"`.
- It must not contain `#` anywhere (`inline_comment`). `A=1 # note` and `A=x#y` are both errors: loaders do not agree on where such a comment starts.
- It must not contain a backslash, a tab, or, after the first character, a double or single quote (`unquoted_forbidden_character`).
- A value that starts with `'` is an error (`single_quote`). There is no single-quoted form.

**Double-quoted.** The text starts with `"` and the same line ends with the closing `"`.

- Between the quotes, exactly five escapes exist: `\n` (LF), `\r` (CR), `\t` (TAB), `\\` (backslash), `\"` (double quote). Any other backslash sequence is an error (`unknown_escape`); that includes `\$` and `\'`.
- Every other character is data, including `#`, `'`, `$`, spaces at either end, a raw tab and other control characters. NUL, CR and LF are never data.
- A raw line break inside quotes is an error. If the line ends before the closing quote and a later line holds an unescaped `"`, the opening line is reported as `raw_newline_in_quotes` and the lines up to that quote are not read as entries. If no later line closes it, the opening line is `unterminated_quote`.
- Nothing may follow the closing quote, not even a space or a comment (`text_after_quote`).
- `A=""` is the empty string, the same as `A=`.

**`$` is always data.** `A=$HOME` is the five characters `$HOME`, and `A="${X}"` is the four characters `${X}`. Nothing is ever expanded, in either form.

### Whitespace

Where a rule above says whitespace, it means any character a loader might trim: everything JavaScript's `\s` matches (space, tab, vertical tab, form feed, no-break space, U+2028, U+2029, U+FEFF and the other Unicode space separators), the characters U+001C to U+001F, and U+0085, which only Python's `str.strip` removes. Inside an unquoted value, between its first and last character, only the tab is forbidden.

## Rejections

A rejected file yields a list of issues. An issue is a line number, a rule, and, only for a name that passed `checkSecretName`, the name. **An issue never contains text from the file**: no value, no rejected name, no part of a line. An accepted file yields its entries in file order, each with its line number; a rejected file yields no entries at all.

| Rule                           | Raised when                                                                                | Carries the name |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ---------------- |
| `file_too_large`               | The file is larger than 1 MiB. Reported alone, as line 0 (the whole file).                 | no               |
| `bom`                          | The file starts with the bytes `EF BB BF`. Reported on line 1.                             | no               |
| `invalid_utf8`                 | The line is not valid UTF-8.                                                               | no               |
| `nul`                          | The line contains U+0000.                                                                  | no               |
| `lone_cr`                      | The line contains a CR that is not part of a CRLF line ending.                             | no               |
| `invalid_line`                 | Whitespace-only line, leading whitespace, or whitespace directly before `=`.               | no               |
| `missing_equals`               | A line that is not empty, not a comment, and has no `=`.                                   | no               |
| `export_prefix`                | The text before `=` starts with `export` and whitespace.                                   | no               |
| `invalid_name`                 | The name does not match the pattern.                                                       | no               |
| `reserved_name`                | The name starts with `SECRETS_`.                                                           | no               |
| `duplicate_name`               | The name already appeared on an earlier line, even one that was rejected for its value.    | yes              |
| `single_quote`                 | The value starts with `'`.                                                                 | yes              |
| `unquoted_whitespace`          | An unquoted value starts or ends with whitespace.                                          | yes              |
| `unquoted_forbidden_character` | An unquoted value contains a backslash, a tab, or a quote after its first character.       | yes              |
| `inline_comment`               | An unquoted value contains `#`.                                                            | yes              |
| `unterminated_quote`           | A quoted value is not closed on its line and no later line closes it.                      | yes              |
| `raw_newline_in_quotes`        | A quoted value is not closed on its line and a later line closes it.                       | yes              |
| `unknown_escape`               | A backslash in a quoted value is followed by something other than `n`, `r`, `t`, `\`, `"`. | yes              |
| `text_after_quote`             | Anything follows the closing quote.                                                        | yes              |
| `value_too_large`              | The value is longer than 65,536 bytes.                                                     | yes              |
| `too_many_entries`             | Reported once, on the line of entry 1,001.                                                 | no               |

How issues are collected:

- Lines are numbered from 1. Line 0 is used only by `file_too_large`.
- Every line is examined; parsing does not stop at the first problem. It stops after 100 issues.
- A line gets at most one issue: the first that applies in the order of the table above. Within a value, that is the first offending character from the left; trailing whitespace is looked at last.
- The four byte-level rules (`bom`, `invalid_utf8`, `nul`, `lone_cr`) apply to every line, comments included, and a line that breaks one is not examined further.

## Canonical form

`serializeDotenv` writes one spelling and no other:

- entries sorted by name in ASCII order (so `A`, `A1`, `AB`, `A_1`, `B`);
- one line per entry: `NAME="<escaped value>"` followed by LF;
- every value double-quoted, the empty string as `""`;
- exactly five characters escaped (LF as `\n`, CR as `\r`, TAB as `\t`, backslash as `\\`, double quote as `\"`) and every other character written as it is;
- UTF-8, no byte order mark, no CR, no comment, no empty line;
- zero entries give zero bytes; otherwise the file ends with LF.

It throws `DotenvEntryError` (a rule and the position of the entry; no name, no value) for a name `checkSecretName` refuses, a repeated name, or a value `checkSecretValue` refuses (NUL, a lone surrogate, more than 65,536 bytes).

### Round trip

For every set of entries the writer accepts, `parseDotenv(serializeDotenv(entries))` returns the same names and values, sorted by name, and writing those again gives the same bytes (FR-1.38). This holds for empty values, Unicode, quotes, backslashes, line breaks and literal dollar sequences, and is tested with generated inputs (`tests/unit/dotenv/roundtrip.test.ts`, 1,000 runs per property).

One boundary is not the codec's to solve: the writer does not refuse a file larger than the import limit. An environment may hold more value bytes than 1 MiB, and escaping can double a value, so a very large export can be rejected on import with `file_too_large`. The import and export runs decide what the service does then.

## Loader compatibility

The canonical form is lossless for this service's parser. Other loaders read some values differently. `loaderWarnings(entries)` names every key a pinned loader reads back as something other than the stored value. A warning is a key name, a loader and a reason; it never contains a value.

| Loader          | Pinned version        | How the test calls it                                                      |
| --------------- | --------------------- | -------------------------------------------------------------------------- |
| `nextjs`        | `@next/env` 16.4.6    | `loadEnvConfig(dir)` on a directory with one `.env`, `NODE_ENV=production` |
| `python-dotenv` | `python-dotenv` 1.2.4 | `dotenv_values(path)` with interpolation on (the default)                  |

### Warning rules

| Loader          | Reason      | Raised for a key when                                                                                                                                                                  |
| --------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextjs`        | `expansion` | its value contains `$`                                                                                                                                                                 |
| `nextjs`        | `escape`    | its value contains a backslash, a double quote or a tab                                                                                                                                |
| `nextjs`        | `escape`    | the entry before it in canonical order has a value that ends with a backslash, and its own value starts with optional whitespace (not tab, LF or CR) followed by `#`, U+2028 or U+2029 |
| `nextjs`        | `escape`    | any entry of the file matches the previous row and has a value that contains U+2028 or U+2029; then every key of the file is warned                                                    |
| `python-dotenv` | `expansion` | its value contains `${`                                                                                                                                                                |

`python-dotenv` never gets an `escape` warning: it resolves the same five escapes the canonical form writes.

Why each rule exists, from reading the pinned loaders and confirmed by the table below:

- **`nextjs` expansion.** `@next/env` expands `$NAME`, `${NAME}` and `${NAME:-default}` from the process environment and from the file, and replaces an undefined name by the empty string. `$` followed by digits is expanded too (`$100 off` becomes ` off`).
- **`nextjs` escape, own value.** Inside double quotes `@next/env` resolves only `\n` and `\r`. It leaves `\t`, `\\` and `\"` as two characters each, so a tab, a backslash or a double quote comes back changed.
- **`nextjs` escape, line before.** `@next/env` treats `\"` as an escaped quote wherever it stands, so the closing quote of a value that ends with a backslash looks like data to it. It then reads on to the opening quote of the next line and stays there if the rest of that line can pass for a comment or an end of line. The next entry disappears; the first one comes back with a piece of the next line appended. This rule was not in the plan; the loader test found it.
- **`nextjs` escape, whole file.** After such a loss, a U+2028 or U+2029 inside the lost value starts a new line for the loader in the middle of the value. Text after it that is shaped like `NAME=…` is taken as an entry and can replace the value of another key (sets `separator-after-backslash` and `hash-separator-after-backslash` below). The static rule does not try to predict which key; it warns for all of them.
- **`python-dotenv` expansion.** `python-dotenv` expands `${NAME}` and `${NAME:-default}` only; a bare `$NAME` is left alone.

The rules may warn for a value a loader happens to return unchanged (for example `cost 5$`). They must never stay silent about a change. They are to be extended when a loader test finds a new difference, and narrowed only with a loader test that proves the narrower rule.

Not covered by the rules, because it does not depend on the file: a key whose name already exists in the process environment. `@next/env` keeps the existing value, and `load_dotenv` does the same unless it is called with `override=True`. This was read in the loaders' source and is not part of the test.

### Observed differences

The block below is generated by `tests/integration/dotenv-loaders/loaders.test.ts` from real runs of both loaders over the canonical file of each set in `tests/fixtures/dotenv-loaders/corpus.json`. The test fails if a loader changes a value without a warning, and it fails if this block differs from what the loaders did. To regenerate it after changing the corpus, the rules or a pinned loader, run the integration tests once with the environment variable `MYKEY_WRITE_LOADER_TABLE=1`.

How to read it: `same` means the loader returned exactly the original value; a JSON string is what it returned instead; **missing** means the loader returned no such name. Values are shown as JSON strings in printable ASCII. Every value in the corpus is synthetic.

<!-- loader-table:start -->
<!-- prettier-ignore-start -->

### Set `main` (57 cases)

One file with every case; neighbours matter, so the order is part of the test.

| Case | Exercises | Original value (JSON) | `@next/env` 16.4.6 | `python-dotenv` 1.2.4 | Warnings |
| --- | --- | --- | --- | --- | --- |
| `DL_01_PLAIN` | plain text | `"plain"` | same | same | none |
| `DL_02_EMPTY` | empty value | `""` | same | same | none |
| `DL_03_SPACES_INSIDE` | interior spaces | `"two  words"` | same | same | none |
| `DL_04_SPACES_AROUND` | leading and trailing spaces | `"  padded  "` | same | same | none |
| `DL_05_ONLY_SPACES` | only spaces | `"   "` | same | same | none |
| `DL_06_EQUALS` | equals signs | `"a=b=c"` | same | same | none |
| `DL_07_HASH_INSIDE` | hash after a space | `"a # b"` | same | same | none |
| `DL_08_HASH_FIRST` | hash as first character | `"#not a comment"` | same | same | none |
| `DL_09_SINGLE_QUOTE` | single quote inside | `"it's"` | same | same | none |
| `DL_10_SINGLE_QUOTED` | wrapped in single quotes | `"'quoted'"` | same | same | none |
| `DL_11_BACKTICK` | backticks | `` "`tick`" `` | same | same | none |
| `DL_12_DOUBLE_QUOTE` | double quotes inside | `"say \"hi\""` | `"say \\\"hi\\\""` | same | nextjs: escape |
| `DL_13_ONLY_DOUBLE_QUOTE` | one double quote | `"\""` | `"\\\""` | same | nextjs: escape |
| `DL_14_LINE_FEED` | line feed (two lines) | `"line one\nline two"` | same | same | none |
| `DL_15_CARRIAGE_RETURN` | carriage return | `"a\rb"` | same | same | none |
| `DL_16_CRLF` | CRLF inside the value | `"a\r\nb"` | same | same | none |
| `DL_17_TAB` | tab | `"a\tb"` | `"a\\tb"` | same | nextjs: escape |
| `DL_18_BACKSLASH` | backslash | `"a\\b"` | `"a\\\\b"` | same | nextjs: escape |
| `DL_19_BACKSLASH_N` | backslash followed by n (not a line feed) | `"a\\nb"` | `"a\\\nb"` | same | nextjs: escape |
| `DL_20_WINDOWS_PATH` | Windows path | `"C:\\temp\\new"` | `"C:\\\\temp\\\new"` | same | nextjs: escape |
| `DL_21_DOLLAR_VAR` | $NAME of another entry | `"$DL_01_PLAIN"` | `"plain"` | same | nextjs: expansion |
| `DL_22_DOLLAR_BRACE` | ${NAME} of another entry | `"${DL_01_PLAIN}"` | `"plain"` | `"plain"` | nextjs: expansion; python-dotenv: expansion |
| `DL_23_DOLLAR_UNDEFINED` | $NAME that is not defined | `"$DL_UNDEFINED_X"` | `""` | same | nextjs: expansion |
| `DL_24_BRACE_UNDEFINED` | ${NAME} that is not defined | `"${DL_UNDEFINED_X}"` | `""` | `""` | nextjs: expansion; python-dotenv: expansion |
| `DL_25_BRACE_DEFAULT` | ${NAME:-default} | `"${DL_UNDEFINED_X:-fallback}"` | `"fallback"` | `"fallback"` | nextjs: expansion; python-dotenv: expansion |
| `DL_26_ESCAPED_DOLLAR` | backslash before a dollar | `"\\$DL_01_PLAIN"` | same | same | nextjs: expansion; nextjs: escape |
| `DL_27_LONE_DOLLAR` | dollar at the end | `"cost 5$"` | same | same | nextjs: expansion |
| `DL_28_DOLLAR_DIGITS` | dollar before digits | `"$100 off"` | `" off"` | same | nextjs: expansion |
| `DL_29_DOUBLE_DOLLAR` | two dollars | `"a$$b"` | `"a$"` | same | nextjs: expansion |
| `DL_30_DOLLAR_PAREN` | dollar before a parenthesis | `"$(echo x)"` | same | same | nextjs: expansion |
| `DL_31_UNCLOSED_BRACE` | dollar-brace never closed | `"a${b"` | `"a"` | same | nextjs: expansion; python-dotenv: expansion |
| `DL_32_UNICODE` | non-ASCII text | `"na\u00efve \ud83d\udd11 \u65e5\u672c\u8a9e"` | same | same | none |
| `DL_33_NBSP_AROUND` | no-break spaces at both ends | `"\u00a0x\u00a0"` | same | same | none |
| `DL_34_CONTROL` | control characters U+0001 and U+001B | `"a\u0001b\u001bc"` | same | same | none |
| `DL_35_VTAB_FORM_FEED` | vertical tab and form feed | `"a\u000bb\fc"` | same | same | none |
| `DL_36_LINE_SEPARATOR` | U+2028 and U+2029 inside | `"a\u2028b\u2029c"` | same | same | none |
| `DL_37_BOM_CHARACTER` | U+FEFF as first character | `"\ufeffx"` | same | same | none |
| `DL_38_EXPORT_WORD` | looks like an export line | `"export X=1"` | same | same | none |
| `DL_39_LOOKS_LIKE_ENTRIES` | two lines that look like entries | `"A=1\nB=2"` | same | same | none |
| `DL_40_PUNCTUATION` | other punctuation | `"100% !done; (a) [b] {c} <d> ~ ^ & * ? , . : @"` | same | same | none |
| `DL_41_ENDS_BACKSLASH` | ends with a backslash, next value starts with a hash | `"ends with backslash\\"` | `"ends with backslash\\\\\"\nDL_42_HASH_AFTER_BACKSLASH="` | same | nextjs: escape |
| `DL_42_HASH_AFTER_BACKSLASH` | starts with a hash, after a value that ends with a backslash | `"#swallowed"` | **missing** | same | nextjs: escape |
| `DL_43_AFTER_SWALLOWED` | plain text after the two entries above | `"still here"` | same | same | none |
| `DL_44_ENDS_BACKSLASH_2` | ends with a backslash, next value is plain | `"C:\\dir\\"` | `"C:\\\\dir\\\\"` | same | nextjs: escape |
| `DL_45_PLAIN_AFTER_BACKSLASH` | plain text after a value that ends with a backslash | `"plain after backslash"` | same | same | none |
| `DL_46_ENDS_BACKSLASH_3` | ends with two backslashes, next value starts with space and hash | `"two\\\\"` | `"two\\\\\\\\\"\nDL_47_SPACE_HASH_AFTER="` | same | nextjs: escape |
| `DL_47_SPACE_HASH_AFTER` | space then hash, after a value that ends with a backslash | `" # spaced"` | **missing** | same | nextjs: escape |
| `DL_48_ENDS_QUOTE` | ends with a double quote, next value starts with a hash | `"ends with quote\""` | `"ends with quote\\\""` | same | nextjs: escape |
| `DL_49_HASH_AFTER_QUOTE` | starts with a hash, after a value that ends with a quote | `"#after quote"` | same | same | none |
| `DL_50_BACKSLASH_QUOTE` | backslash directly before a double quote | `"a\\\"b"` | `"a\\\\\\\"b"` | same | nextjs: escape |
| `DL_51_URL` | URL with a query | `"http://localhost:3000/path?x=1&y=2"` | same | same | none |
| `DL_52_JSON` | JSON text | `"{\"a\": [1, 2]}"` | `"{\\\"a\\\": [1, 2]}"` | same | nextjs: escape |
| `DL_53_ENDS_BACKSLASH_4` | ends with a backslash, next value starts with a line feed and a hash | `"four\\"` | `"four\\\\"` | same | nextjs: escape |
| `DL_54_LF_HASH_AFTER` | line feed then hash, after a value that ends with a backslash | `"\n#after line feed"` | same | same | none |
| `DL_55_ENDS_BACKSLASH_5` | ends with a backslash, next value starts with other whitespace and a hash | `"five\\"` | `"five\\\\\"\nDL_56_NBSP_HASH_AFTER="` | same | nextjs: escape |
| `DL_56_NBSP_HASH_AFTER` | no-break space, vertical tab, then hash, after a value that ends with a backslash | `"\u00a0\u000b#after no-break space"` | **missing** | same | nextjs: escape |
| `DL_57_LAST_ENDS_BACKSLASH` | last line of the file ends with a backslash | `"last\\"` | `"last\\\\"` | same | nextjs: escape |

Names `@next/env` returned that are not in the file: none.

Names `python-dotenv` returned that are not in the file: none.

### Set `separator-after-backslash` (4 cases)

A value that starts with U+2028 directly after a value that ends with a backslash.

| Case | Exercises | Original value (JSON) | `@next/env` 16.4.6 | `python-dotenv` 1.2.4 | Warnings |
| --- | --- | --- | --- | --- | --- |
| `DLX_0_TARGET` | sorted first; a later value names it after a line separator | `"original"` | `"injected\""` | same | nextjs: escape |
| `DLX_1_ENDS_BACKSLASH` | ends with a backslash | `"x\\"` | `"x\\\\\"\nDLX_2_SEPARATOR_FIRST="` | same | nextjs: escape |
| `DLX_2_SEPARATOR_FIRST` | U+2028 first, then text shaped like an entry | `"\u2028DLX_0_TARGET=injected"` | **missing** | same | nextjs: escape |
| `DLX_3_AFTER` | plain text after | `"after"` | same | same | nextjs: escape |

Names `@next/env` returned that are not in the file: none.

Names `python-dotenv` returned that are not in the file: none.

### Set `hash-separator-after-backslash` (4 cases)

A value that starts with a hash and contains U+2029, directly after a value that ends with a backslash.

| Case | Exercises | Original value (JSON) | `@next/env` 16.4.6 | `python-dotenv` 1.2.4 | Warnings |
| --- | --- | --- | --- | --- | --- |
| `DLY_0_TARGET` | sorted first; a later value names it after a paragraph separator | `"original"` | `"injected\""` | same | nextjs: escape |
| `DLY_1_ENDS_BACKSLASH` | ends with a backslash | `"y\\"` | `"y\\\\\"\nDLY_2_HASH_SEPARATOR="` | same | nextjs: escape |
| `DLY_2_HASH_SEPARATOR` | hash first, then U+2029, then text shaped like an entry | `"# note\u2029DLY_0_TARGET=injected"` | **missing** | same | nextjs: escape |
| `DLY_3_AFTER` | plain text after | `"after"` | same | same | nextjs: escape |

Names `@next/env` returned that are not in the file: none.

Names `python-dotenv` returned that are not in the file: none.

### Warnings against observed changes

| Loader | Reason | Cases warned | Of those, changed by the loader | Changed without a warning |
| --- | --- | --- | --- | --- |
| `@next/env` | expansion | 11 | 8 | 0 |
| `@next/env` | escape | 27 | 24 | 0 |
| `python-dotenv` | expansion | 4 | 3 | 0 |
| `python-dotenv` | escape | 0 | 0 | 0 |

<!-- prettier-ignore-end -->
<!-- loader-table:end -->

## Decisions where Document 04 leaves room

All on the strict side.

| Question                                             | Decision                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Whitespace-only line                                 | Error (`invalid_line`), not an empty line.                                                     |
| Whitespace around `=`                                | Before `=`: `invalid_line`. After `=`: it is the start of the value, so `unquoted_whitespace`. |
| Which characters count as whitespace                 | Every character either loader could trim, not only space and tab (see Whitespace).             |
| `#` in an unquoted value                             | Error anywhere in the value, not only after a space.                                           |
| CR alone                                             | Error; it is not a line ending.                                                                |
| Tab and control characters inside quotes             | Data. Only NUL, CR and LF are excluded.                                                        |
| Byte order mark                                      | Error at the start of the file. U+FEFF elsewhere is an ordinary character.                     |
| A quote left open                                    | `raw_newline_in_quotes` when a later line closes it, else `unterminated_quote`.                |
| `A=` and `A=""`                                      | Both are the empty string.                                                                     |
| Line number of `file_too_large`                      | 0: the file is not split into lines before the size check.                                     |
| More than one problem on a line                      | One issue per line, the first in rule order.                                                   |
| Duplicate detection when the first line was rejected | The name still counts as seen.                                                                 |
