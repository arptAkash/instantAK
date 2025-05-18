<script>
	import { onMount } from "svelte";
	// export let name;
	let inputRef = null;
	onMount(() => {
		inputRef.focus();
	});
</script>

<main class="section is-medium columns is-flex is-vcentered">
	<div class="container is-max-desktop has-text-centered">
		<h1 class="title">Instant Read Bot</h1>
		<form action="/api/readability" method="get" class="search-form">
			<div class="field has-addons">
				<p class="control is-expanded">
					<input
						name="url"
						type="url"
						required
						placeholder='Link to an article'
						bind:this={inputRef}
						class="input is-rounded has-text-centered search-box"
					/>
				</p>
				<p class="control">
					<input
						type="submit"
						value="Read"
						class="button is-link is-outlined is-rounded search-button"
					/>
				</p>
			</div>
		</form>
		<p>
			Telegram:
			<a href="https://t.me/userInstantBot" target="_blank"> @userInstantBot </a>
		</p>
	</div>
</main>

<style>
	main {
		min-width: 100vw;
		min-height: 100vh;
		margin-top: -54px;
	}

	h1 {
		color: #ff3e00;
		text-transform: uppercase;
		font-size: 3.6em;
		font-weight: 100;
	}

	.seperator {
		padding: 0 3px;
	}

	.search-form .field {
		margin: 2rem 4rem;
	}

	@media (max-width: 768px) {
		.search-form .field {
			margin: 2rem 0rem;
		}
	}
</style>
