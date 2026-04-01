<template>
  <div class="join-view">
    <h2>Joining server…</h2>
    <p>Invite code: {{ $route.params.inviteCode }}</p>
  </div>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router'
const $route = useRoute()
</script>
