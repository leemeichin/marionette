// Copy controls for static samples. Progressive enhancement: the source is
// complete HTML and the button simply saves a select-and-copy gesture.

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const sample = button.closest('.code-sample');
    const code = sample?.querySelector('code');
    if (!code) return;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'copied';
    } catch {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'selected';
    }
    window.setTimeout(() => { button.textContent = original; }, 1600);
  });
}
