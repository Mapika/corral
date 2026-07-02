<script>
  // Shell picker: phones (and the standalone mobile app, always) get the purpose-built mobile
  // console; everything else gets the desktop operator console. Re-evaluates on rotation/resize.
  import App from './App.svelte';
  import MobileShell from './mobile/MobileShell.svelte';

  let { standalone = false, paired = true } = $props();

  const mq = typeof window !== 'undefined' ? window.matchMedia('(max-width: 700px)') : null;
  let narrow = $state(mq ? mq.matches : false);
  $effect(() => {
    if (!mq) return;
    const onChange = (e) => (narrow = e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });
</script>

{#if standalone || narrow}
  <MobileShell {standalone} initialPaired={paired} />
{:else}
  <App />
{/if}
