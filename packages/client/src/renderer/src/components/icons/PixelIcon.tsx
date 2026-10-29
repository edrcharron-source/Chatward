// Pixel icons for the tabs layout, drawn on a 12 x 12 grid so they stay sharp next to text. Each one is a single path
// filled with the current text colour, so it follows the theme and skins like the text around it.
const PATHS = {
  text: 'M2 1h2v1h-2zM7 1h2v1h-2zM2 2h2v1h-2zM7 2h2v1h-2zM0 3h10v1h-10zM2 4h2v1h-2zM7 4h2v1h-2zM2 5h2v1h-2zM7 5h2v1h-2zM1 6h2v1h-2zM6 6h2v1h-2zM0 7h10v1h-10zM1 8h2v1h-2zM6 8h2v1h-2zM1 9h2v1h-2zM6 9h2v1h-2z',
  voice: 'M5 1h1v1h-1zM4 2h2v1h-2zM9 2h1v1h-1zM1 3h4v1h-4zM6 3h1v1h-1zM10 3h1v1h-1zM1 4h4v1h-4zM7 4h1v1h-1zM10 4h1v1h-1zM1 5h4v1h-4zM7 5h1v1h-1zM10 5h1v1h-1zM1 6h4v1h-4zM7 6h1v1h-1zM10 6h1v1h-1zM1 7h4v1h-4zM6 7h1v1h-1zM10 7h1v1h-1zM4 8h2v1h-2zM9 8h1v1h-1zM5 9h1v1h-1z',
  mic: 'M4 0h4v1h-4zM3 1h1v1h-1zM8 1h1v1h-1zM3 2h1v1h-1zM5 2h2v1h-2zM8 2h1v1h-1zM3 3h1v1h-1zM5 3h2v1h-2zM8 3h1v1h-1zM3 4h1v1h-1zM5 4h2v1h-2zM8 4h1v1h-1zM1 5h1v1h-1zM3 5h1v1h-1zM8 5h1v1h-1zM10 5h1v1h-1zM1 6h1v1h-1zM4 6h4v1h-4zM10 6h1v1h-1zM2 7h1v1h-1zM9 7h1v1h-1zM3 8h6v1h-6zM5 9h2v1h-2zM3 10h6v1h-6z',
  micoff: 'M0 0h1v1h-1zM4 0h4v1h-4zM1 1h1v1h-1zM3 1h1v1h-1zM8 1h1v1h-1zM2 2h2v1h-2zM5 2h2v1h-2zM8 2h1v1h-1zM3 3h2v1h-2zM6 3h1v1h-1zM8 3h1v1h-1zM3 4h1v1h-1zM5 4h2v1h-2zM8 4h1v1h-1zM1 5h1v1h-1zM3 5h1v1h-1zM6 5h1v1h-1zM8 5h1v1h-1zM10 5h1v1h-1zM1 6h1v1h-1zM4 6h4v1h-4zM10 6h1v1h-1zM2 7h1v1h-1zM8 7h2v1h-2zM3 8h6v1h-6zM10 8h1v1h-1zM5 9h2v1h-2zM11 9h1v1h-1zM3 10h6v1h-6z',
  deafen: 'M3 1h6v1h-6zM2 2h1v1h-1zM9 2h1v1h-1zM1 3h1v1h-1zM10 3h1v1h-1zM1 4h1v1h-1zM10 4h1v1h-1zM0 5h3v1h-3zM9 5h3v1h-3zM0 6h3v1h-3zM9 6h3v1h-3zM0 7h3v1h-3zM9 7h3v1h-3zM0 8h3v1h-3zM9 8h3v1h-3zM1 9h2v1h-2zM9 9h2v1h-2z',
  share: 'M0 0h12v1h-12zM0 1h1v1h-1zM11 1h1v1h-1zM0 2h1v1h-1zM5 2h2v1h-2zM11 2h1v1h-1zM0 3h1v1h-1zM4 3h4v1h-4zM11 3h1v1h-1zM0 4h1v1h-1zM3 4h6v1h-6zM11 4h1v1h-1zM0 5h1v1h-1zM5 5h2v1h-2zM11 5h1v1h-1zM0 6h1v1h-1zM5 6h2v1h-2zM11 6h1v1h-1zM0 7h1v1h-1zM11 7h1v1h-1zM0 8h12v1h-12zM5 9h2v1h-2zM3 10h6v1h-6z',
  camera: 'M0 2h8v1h-8zM0 3h1v1h-1zM7 3h1v1h-1zM10 3h2v1h-2zM0 4h1v1h-1zM2 4h4v1h-4zM7 4h1v1h-1zM9 4h3v1h-3zM0 5h1v1h-1zM2 5h1v1h-1zM5 5h1v1h-1zM7 5h5v1h-5zM0 6h1v1h-1zM2 6h1v1h-1zM5 6h1v1h-1zM7 6h5v1h-5zM0 7h1v1h-1zM2 7h4v1h-4zM7 7h1v1h-1zM9 7h3v1h-3zM0 8h1v1h-1zM7 8h1v1h-1zM10 8h2v1h-2zM0 9h8v1h-8z',
  leave: 'M2 2h8v1h-8zM1 3h10v1h-10zM0 4h3v1h-3zM9 4h3v1h-3zM0 5h2v1h-2zM10 5h2v1h-2zM0 6h3v1h-3zM9 6h3v1h-3zM1 7h2v1h-2zM9 7h2v1h-2zM4 9h1v1h-1zM7 9h1v1h-1zM5 10h2v1h-2zM4 11h1v1h-1zM7 11h1v1h-1z',
  watch: 'M0 0h12v1h-12zM0 1h1v1h-1zM2 1h1v1h-1zM9 1h1v1h-1zM11 1h1v1h-1zM0 2h3v1h-3zM9 2h3v1h-3zM0 3h1v1h-1zM2 3h1v1h-1zM4 3h1v1h-1zM9 3h1v1h-1zM11 3h1v1h-1zM0 4h3v1h-3zM4 4h2v1h-2zM9 4h3v1h-3zM0 5h1v1h-1zM2 5h1v1h-1zM4 5h3v1h-3zM9 5h1v1h-1zM11 5h1v1h-1zM0 6h3v1h-3zM4 6h2v1h-2zM9 6h3v1h-3zM0 7h1v1h-1zM2 7h1v1h-1zM4 7h1v1h-1zM9 7h1v1h-1zM11 7h1v1h-1zM0 8h3v1h-3zM9 8h3v1h-3zM0 9h1v1h-1zM2 9h1v1h-1zM9 9h1v1h-1zM11 9h1v1h-1zM0 10h12v1h-12z',
  movies: 'M2 0h1v1h-1zM8 0h1v1h-1zM3 1h1v1h-1zM7 1h1v1h-1zM4 2h1v1h-1zM6 2h1v1h-1zM0 3h12v1h-12zM0 4h1v1h-1zM9 4h1v1h-1zM11 4h1v1h-1zM0 5h1v1h-1zM9 5h3v1h-3zM0 6h1v1h-1zM9 6h1v1h-1zM11 6h1v1h-1zM0 7h1v1h-1zM9 7h3v1h-3zM0 8h1v1h-1zM9 8h1v1h-1zM11 8h1v1h-1zM0 9h12v1h-12zM1 10h2v1h-2zM9 10h2v1h-2z',
  vault: 'M0 0h12v1h-12zM0 1h1v1h-1zM11 1h1v1h-1zM0 2h1v1h-1zM2 2h8v1h-8zM11 2h1v1h-1zM0 3h1v1h-1zM2 3h1v1h-1zM9 3h1v1h-1zM11 3h1v1h-1zM0 4h1v1h-1zM2 4h1v1h-1zM4 4h4v1h-4zM9 4h1v1h-1zM11 4h1v1h-1zM0 5h1v1h-1zM2 5h1v1h-1zM4 5h1v1h-1zM7 5h1v1h-1zM9 5h1v1h-1zM11 5h1v1h-1zM0 6h1v1h-1zM2 6h1v1h-1zM4 6h4v1h-4zM9 6h1v1h-1zM11 6h1v1h-1zM0 7h1v1h-1zM2 7h1v1h-1zM5 7h2v1h-2zM9 7h1v1h-1zM11 7h1v1h-1zM0 8h1v1h-1zM2 8h8v1h-8zM11 8h1v1h-1zM0 9h1v1h-1zM11 9h1v1h-1zM0 10h12v1h-12zM1 11h2v1h-2zM9 11h2v1h-2z',
  gear: 'M5 0h2v1h-2zM2 1h1v1h-1zM5 1h2v1h-2zM9 1h1v1h-1zM3 2h6v1h-6zM3 3h2v1h-2zM7 3h2v1h-2zM0 4h4v1h-4zM8 4h4v1h-4zM0 5h4v1h-4zM8 5h4v1h-4zM3 6h2v1h-2zM7 6h2v1h-2zM3 7h6v1h-6zM2 8h1v1h-1zM5 8h2v1h-2zM9 8h1v1h-1zM5 9h2v1h-2z',
  plus: 'M5 1h2v1h-2zM5 2h2v1h-2zM5 3h2v1h-2zM1 4h10v1h-10zM1 5h10v1h-10zM5 6h2v1h-2zM5 7h2v1h-2zM5 8h2v1h-2z',
  attach: 'M6 0h3v1h-3zM5 1h1v1h-1zM9 1h1v1h-1zM4 2h1v1h-1zM7 2h1v1h-1zM9 2h1v1h-1zM3 3h1v1h-1zM6 3h1v1h-1zM9 3h1v1h-1zM2 4h1v1h-1zM5 4h1v1h-1zM8 4h1v1h-1zM1 5h1v1h-1zM4 5h1v1h-1zM7 5h1v1h-1zM1 6h1v1h-1zM3 6h1v1h-1zM6 6h1v1h-1zM1 7h1v1h-1zM5 7h1v1h-1zM2 8h3v1h-3z',
  gif: 'M1 2h3v1h-3zM5 2h1v1h-1zM7 2h4v1h-4zM0 3h1v1h-1zM5 3h1v1h-1zM7 3h1v1h-1zM0 4h1v1h-1zM2 4h2v1h-2zM5 4h1v1h-1zM7 4h3v1h-3zM0 5h1v1h-1zM3 5h1v1h-1zM5 5h1v1h-1zM7 5h1v1h-1zM1 6h3v1h-3zM5 6h1v1h-1zM7 6h1v1h-1zM0 8h12v1h-12z',
  emoji: 'M3 0h6v1h-6zM2 1h1v1h-1zM9 1h1v1h-1zM1 2h1v1h-1zM10 2h1v1h-1zM0 3h1v1h-1zM3 3h2v1h-2zM7 3h2v1h-2zM11 3h1v1h-1zM0 4h1v1h-1zM3 4h2v1h-2zM7 4h2v1h-2zM11 4h1v1h-1zM0 5h1v1h-1zM11 5h1v1h-1zM0 6h1v1h-1zM2 6h1v1h-1zM9 6h1v1h-1zM11 6h1v1h-1zM0 7h1v1h-1zM3 7h1v1h-1zM8 7h1v1h-1zM11 7h1v1h-1zM1 8h1v1h-1zM4 8h4v1h-4zM10 8h1v1h-1zM2 9h1v1h-1zM9 9h1v1h-1zM3 10h6v1h-6z',
  send: 'M0 1h2v1h-2zM0 2h1v1h-1zM2 2h3v1h-3zM0 3h1v1h-1zM5 3h3v1h-3zM1 4h1v1h-1zM8 4h3v1h-3zM2 5h9v1h-9zM1 6h1v1h-1zM8 6h3v1h-3zM0 7h1v1h-1zM5 7h3v1h-3zM0 8h1v1h-1zM2 8h3v1h-3zM0 9h2v1h-2z',
  edit: 'M9 0h2v1h-2zM8 1h1v1h-1zM11 1h1v1h-1zM7 2h1v1h-1zM10 2h1v1h-1zM6 3h1v1h-1zM9 3h1v1h-1zM5 4h1v1h-1zM8 4h1v1h-1zM4 5h1v1h-1zM7 5h1v1h-1zM3 6h1v1h-1zM6 6h1v1h-1zM2 7h1v1h-1zM5 7h1v1h-1zM1 8h2v1h-2zM4 8h1v1h-1zM1 9h3v1h-3z',
  trash: 'M4 0h4v1h-4zM0 1h12v1h-12zM1 3h10v1h-10zM1 4h1v1h-1zM3 4h1v1h-1zM6 4h1v1h-1zM9 4h1v1h-1zM1 5h1v1h-1zM3 5h1v1h-1zM6 5h1v1h-1zM9 5h1v1h-1zM1 6h1v1h-1zM3 6h1v1h-1zM6 6h1v1h-1zM9 6h1v1h-1zM1 7h1v1h-1zM3 7h1v1h-1zM6 7h1v1h-1zM9 7h1v1h-1zM1 8h1v1h-1zM3 8h1v1h-1zM6 8h1v1h-1zM9 8h1v1h-1zM1 9h9v1h-9z',
  sounds: 'M4 1h1v1h-1zM4 2h1v1h-1zM8 2h1v1h-1zM1 3h1v1h-1zM4 3h1v1h-1zM8 3h1v1h-1zM1 4h1v1h-1zM4 4h1v1h-1zM6 4h1v1h-1zM8 4h1v1h-1zM10 4h1v1h-1zM1 5h1v1h-1zM3 5h2v1h-2zM6 5h1v1h-1zM8 5h1v1h-1zM10 5h1v1h-1zM0 6h2v1h-2zM3 6h2v1h-2zM6 6h5v1h-5zM1 7h1v1h-1zM3 7h2v1h-2zM6 7h1v1h-1zM8 7h1v1h-1zM10 7h1v1h-1zM1 8h1v1h-1zM4 8h1v1h-1zM6 8h1v1h-1zM8 8h1v1h-1zM10 8h1v1h-1zM1 9h1v1h-1zM4 9h1v1h-1zM8 9h1v1h-1zM4 10h1v1h-1z',
  fullscreen: 'M0 0h3v1h-3zM9 0h3v1h-3zM0 1h2v1h-2zM10 1h2v1h-2zM0 2h1v1h-1zM2 2h1v1h-1zM9 2h1v1h-1zM11 2h1v1h-1zM0 9h1v1h-1zM2 9h1v1h-1zM9 9h1v1h-1zM11 9h1v1h-1zM0 10h2v1h-2zM10 10h2v1h-2zM0 11h3v1h-3zM9 11h3v1h-3z',
  theater: 'M0 0h12v1h-12zM0 1h1v1h-1zM11 1h1v1h-1zM0 2h1v1h-1zM11 2h1v1h-1zM0 3h1v1h-1zM11 3h1v1h-1zM0 4h1v1h-1zM11 4h1v1h-1zM0 5h1v1h-1zM11 5h1v1h-1zM0 6h1v1h-1zM11 6h1v1h-1zM0 7h12v1h-12zM1 9h3v1h-3zM5 9h6v1h-6z',
  popout: 'M6 0h6v1h-6zM9 1h3v1h-3zM8 2h1v1h-1zM11 2h1v1h-1zM7 3h1v1h-1zM11 3h1v1h-1zM0 4h6v1h-6zM7 4h1v1h-1zM0 5h1v1h-1zM6 5h1v1h-1zM0 6h1v1h-1zM0 7h1v1h-1zM0 8h1v1h-1zM0 9h1v1h-1zM0 10h1v1h-1zM6 10h1v1h-1zM0 11h7v1h-7z',
  user: 'M4 0h4v1h-4zM3 1h6v1h-6zM3 2h6v1h-6zM3 3h6v1h-6zM4 4h4v1h-4zM2 6h8v1h-8zM1 7h10v1h-10zM1 8h10v1h-10zM1 9h10v1h-10z',
  shield: 'M1 0h10v1h-10zM1 1h1v1h-1zM10 1h1v1h-1zM1 2h1v1h-1zM5 2h2v1h-2zM10 2h1v1h-1zM1 3h1v1h-1zM4 3h4v1h-4zM10 3h1v1h-1zM1 4h1v1h-1zM5 4h2v1h-2zM10 4h1v1h-1zM1 5h1v1h-1zM5 5h2v1h-2zM10 5h1v1h-1zM1 6h1v1h-1zM10 6h1v1h-1zM2 7h1v1h-1zM9 7h1v1h-1zM3 8h1v1h-1zM8 8h1v1h-1zM4 9h1v1h-1zM7 9h1v1h-1zM5 10h2v1h-2z',
  bell: 'M5 0h2v1h-2zM4 1h4v1h-4zM3 2h1v1h-1zM8 2h1v1h-1zM3 3h1v1h-1zM8 3h1v1h-1zM2 4h1v1h-1zM9 4h1v1h-1zM2 5h1v1h-1zM9 5h1v1h-1zM2 6h1v1h-1zM9 6h1v1h-1zM1 7h1v1h-1zM10 7h1v1h-1zM0 8h12v1h-12zM5 9h2v1h-2z',
  eye: 'M4 2h4v1h-4zM2 3h2v1h-2zM8 3h2v1h-2zM1 4h1v1h-1zM5 4h2v1h-2zM10 4h1v1h-1zM0 5h1v1h-1zM4 5h4v1h-4zM11 5h1v1h-1zM0 6h1v1h-1zM4 6h4v1h-4zM11 6h1v1h-1zM1 7h1v1h-1zM5 7h2v1h-2zM10 7h1v1h-1zM2 8h2v1h-2zM8 8h2v1h-2zM4 9h4v1h-4z',
  palette: 'M3 0h6v1h-6zM2 1h1v1h-1zM9 1h1v1h-1zM1 2h1v1h-1zM3 2h2v1h-2zM7 2h2v1h-2zM11 2h1v1h-1zM0 3h1v1h-1zM3 3h2v1h-2zM7 3h2v1h-2zM11 3h1v1h-1zM0 4h1v1h-1zM11 4h1v1h-1zM0 5h1v1h-1zM2 5h2v1h-2zM9 5h3v1h-3zM0 6h1v1h-1zM2 6h2v1h-2zM8 6h1v1h-1zM0 7h1v1h-1zM8 7h1v1h-1zM1 8h1v1h-1zM9 8h1v1h-1zM2 9h1v1h-1zM4 9h3v1h-3zM10 9h1v1h-1zM3 10h2v1h-2zM7 10h3v1h-3z',
  crown: 'M0 1h1v1h-1zM5 1h1v1h-1zM10 1h1v1h-1zM0 2h2v1h-2zM4 2h3v1h-3zM9 2h2v1h-2zM0 3h11v1h-11zM0 4h11v1h-11zM0 5h11v1h-11zM0 6h11v1h-11z',
  test: 'M3 0h6v1h-6zM4 1h1v1h-1zM7 1h1v1h-1zM4 2h1v1h-1zM7 2h1v1h-1zM4 3h1v1h-1zM7 3h1v1h-1zM3 4h1v1h-1zM8 4h1v1h-1zM2 5h1v1h-1zM9 5h1v1h-1zM1 6h1v1h-1zM4 6h4v1h-4zM10 6h1v1h-1zM0 7h1v1h-1zM3 7h6v1h-6zM11 7h1v1h-1zM0 8h1v1h-1zM2 8h8v1h-8zM11 8h1v1h-1zM1 9h10v1h-10z',
  lock: 'M4 0h4v1h-4zM3 1h1v1h-1zM8 1h1v1h-1zM2 2h1v1h-1zM9 2h1v1h-1zM2 3h1v1h-1zM9 3h1v1h-1zM1 4h10v1h-10zM1 5h10v1h-10zM1 6h4v1h-4zM7 6h4v1h-4zM1 7h4v1h-4zM7 7h4v1h-4zM1 8h5v1h-5zM7 8h4v1h-4zM1 9h10v1h-10z',
  play: 'M2 1h1v1h-1zM2 2h3v1h-3zM2 3h5v1h-5zM2 4h7v1h-7zM2 5h9v1h-9zM2 6h7v1h-7zM2 7h5v1h-5zM2 8h3v1h-3zM2 9h1v1h-1z',
  stop: 'M2 2h8v1h-8zM2 3h8v1h-8zM2 4h8v1h-8zM2 5h8v1h-8zM2 6h8v1h-8zM2 7h8v1h-8zM2 8h8v1h-8zM2 9h8v1h-8z',
  upload: 'M5 0h2v1h-2zM4 1h4v1h-4zM3 2h6v1h-6zM2 3h2v1h-2zM5 3h2v1h-2zM8 3h2v1h-2zM5 4h2v1h-2zM5 5h2v1h-2zM5 6h2v1h-2zM0 8h1v1h-1zM11 8h1v1h-1zM0 9h1v1h-1zM11 9h1v1h-1zM0 10h12v1h-12z',
  close: 'M1 1h2v1h-2zM9 1h2v1h-2zM2 2h2v1h-2zM8 2h2v1h-2zM3 3h2v1h-2zM7 3h2v1h-2zM4 4h4v1h-4zM5 5h2v1h-2zM4 6h4v1h-4zM3 7h2v1h-2zM7 7h2v1h-2zM2 8h2v1h-2zM8 8h2v1h-2zM1 9h2v1h-2zM9 9h2v1h-2z',
  dot: 'M4 3h4v1h-4zM3 4h6v1h-6zM3 5h6v1h-6zM3 6h6v1h-6zM3 7h6v1h-6zM4 8h4v1h-4z',
} as const;

export type PixelIconName = keyof typeof PATHS;

export default function PixelIcon({ name, size = 16 }: { name: PixelIconName; size?: number }) {
  return (
    <svg className="cw-pixel-icon" viewBox="0 0 12 12" width={size} height={size} aria-hidden="true" focusable="false"
      shapeRendering="crispEdges">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}
