import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/servers',
    },
    {
      path: '/servers',
      component: () => import('@/views/MainLayout.vue'),
      children: [
        {
          path: ':serverId?/:channelId?',
          name: 'channel',
          component: () => import('@/views/MainLayout.vue'),
        },
      ],
    },
    {
      path: '/join/:inviteCode',
      name: 'join',
      component: () => import('@/views/JoinView.vue'),
    },
  ],
})

export default router
