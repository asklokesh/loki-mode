Changelog drops merge commits

Our release branches are merged with merge commits whose subjects carry the pull request titles, for example `Merge pull request #41 from team/export`, and the generated changelog never lists them.

`CommitsCmd("v1.2.0", "HEAD")` builds:

    git log --no-merges --pretty=format:%s v1.2.0..HEAD

Expected:

    git log --pretty=format:%s v1.2.0..HEAD

so merge subjects become part of the changelog.

Preferred fix: stop passing `--no-merges` when listing the commits for the changelog. Filtering a second query afterwards would also work, but it doubles the git calls.
