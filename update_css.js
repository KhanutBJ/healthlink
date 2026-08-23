const fs = require('fs');
let css = fs.readFileSync('sidepanel.css', 'utf-8');

// Increase base font size
css = css.replace('font-size: 13px;', 'font-size: 15px;');

// Increase all other font sizes by 2px
css = css.replace(/font-size:\s*(\d+)px;/g, (match, size) => {
  if (size === '15') return match; // skip the one we just updated
  return `font-size: ${parseInt(size) + 2}px;`;
});

// Make padding larger for doc-card
css = css.replace(/padding:\s*12px/g, 'padding: 16px');
css = css.replace(/padding:\s*10px/g, 'padding: 14px');

// Improve contrast (cleaner text)
css = css.replace('--text-muted: rgba(160, 170, 200, 0.45);', '--text-muted: rgba(180, 190, 220, 0.7);');
css = css.replace('--text-secondary: rgba(200, 210, 230, 0.65);', '--text-secondary: rgba(220, 230, 250, 0.85);');

fs.writeFileSync('sidepanel.css', css);
console.log('CSS updated');
