# CRIMSON THRONE

An 18+ open-world dark-fantasy action RPG. It is served at https://games.johnslagboom.com/crimson-throne/ (GitHub Pages, repo JBoom380/crimson-throne).

- Edit `src/*.js`, then run `python src/build.py`. It inlines everything into `index.html`, one offline file. Never edit `index.html` by hand.
- `src/SPEC.md` is the contract between the modules. `game.js` is the core.
- Test with `python src/tools/shot.py out.png --eval "CT.debug.play()"` (real GPU).
- Content rules: gore on monsters only. The heroines are non-explicit. The 18+ gate stays on the game page.
