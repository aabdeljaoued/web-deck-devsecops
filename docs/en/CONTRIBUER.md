# Contributing to the documentation

[← Contents](README.md)

This documentation follows the **Doc as Code** approach: Markdown files in `docs/`, versioned with the code. The
English version lives in `docs/en/`, with the same file names.

## The rule

**Every improvement, fix or new feature updates the documentation in the same commit**: the page concerned, in French
and in English, and the screenshot if the interface changed. The `README.md` at the root stays the technical reference
(configuration, details); `docs/` is the user guide.

## Organisation

- `README.md`: contents (every page must be listed).
- `NN-topic.md`: one page per topic, with a link back to the contents.
- `img/`: JPEG screenshots, 1280 px wide (`sips -s format jpeg -s formatOptions 72 --resampleWidth 1280`), shared by
  both languages (`../img/…` from `docs/en/`).
- `en/`: the English pages, same names as the French ones.

## Screenshots

They are taken on a **demonstration deck**, never on real data:

- a copy of the deck on another port (7778), with a **fictitious** home folder (`HOME` and `ZDOTDIR` pointing to a
  demonstration folder: neutral prompt, fake SSH hosts and keys);
- **made-up** favorites, My actions, missions, notes and secrets (`*.example.test`);
- a demonstration vault with a generated password;
- before each screenshot: no user name, machine name or personal path visible.

## Automatic checks

`npm test` (and the GitHub CI) checks that:

- every link to a page or an image of `docs/` exists, in both languages;
- every image in `docs/img/` is used (no orphan image);
- every page is listed in the contents and links back to it;
- every French page has its English version, with the same screenshots.

## Reading the documentation in the deck

The **?** button in the header opens these pages inside the deck (images included), in the interface language; links
between pages work there.
