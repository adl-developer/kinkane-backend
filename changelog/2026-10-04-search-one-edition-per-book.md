# Search shows each book once, in its best edition

**Date:** 2026-10-04

## What changed

Search results and search-as-you-type suggestions now show each book once. Before, a search for *Bel Canto* listed Ann Patchett's novel four times (two paperbacks, the audiobook and the annotated hardback), grouped together. Now you see one of them, chosen the same way the shop picks:

1. an edition on the shelf, then one that can be ordered in, then one that can't be bought;
2. within that, hardback, then paperback, then any other format.

So Patchett's *Bel Canto* shows as the annotated hardback, and *The Bel Canto Violin* as its hardback. Robert Toft's *Bel Canto: A Performer's Guide* shows as the paperback, because its hardback is out of stock.

## How "the same book" is decided

Same title and same first author, ignoring case, punctuation, "&" vs "and" and a leading or trailing "The"/"A"/"An", as before. Two spellings are now also treated as the same:

- a format tag on the end of a title: "BEL CANTO PB" is the same book as "Bel Canto" (PB, PBK, HB, HBK);
- an author stored surname first: "Patchett, Ann" is the same person as "Ann Patchett".

Books that share a title but have different authors stay separate.

## Non-obvious decisions

- **This reverses the 2026-09-28 change** that listed every edition in search. Browse already showed one edition per title; search now does the same.
- **Paging skips other editions of a book already shown**, under any spelling, so a later page never shows another edition of a book from an earlier page.
- **Suggestions now look up each book's author** before collapsing. They used to group by title and subtitle only, which was safe while nothing was dropped. Now that the other editions are hidden, the author is needed so that two different books with the same title both stay.
- Cache keys were bumped (`books:list:v12`, `suggestions:v6`) so old grouped results aren't served after deploy.
