(() => {
  const search = document.getElementById('academy-search');
  const kind = document.getElementById('academy-kind');
  const cards = [...document.querySelectorAll('.academy-person')];
  const state = {query: '', kind: 'all'};
  function render() {
    let count = 0;
    for (const card of cards) {
      const visible = (state.kind === 'all' || state.kind === card.dataset.kind)
        && card.dataset.search.includes(state.query);
      card.hidden = !visible;
      if (visible) count += 1;
    }
    document.getElementById('academy-results').textContent = `共 ${count} 个资料入口`;
    document.getElementById('academy-empty').hidden = count > 0;
  }
  search.addEventListener('input', () => {state.query = search.value.trim().toLowerCase(); render();});
  kind.addEventListener('change', () => {state.kind = kind.value; render();});
  search.form.addEventListener('submit', event => event.preventDefault());
})();
