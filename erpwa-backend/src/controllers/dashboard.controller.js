import prisma from "../prisma.js";

/**
 * Get dashboard statistics
 */
export const getDashboardStats = async (req, res) => {
    try {
        const vendorId = req.user.vendorId;
        const user = req.user;

        // Define filter for leads based on role
        const leadFilter = { vendorId };
        if (user.role === 'sales') {
            leadFilter.salesPersonName = user.name;
        }

        // Get counts in parallel
        const [
            teamCount,
            leadsCount,
            templatesCount,
            campaignsCount,
            leadsStatusCount,
        ] = await Promise.all([
            // Team members count
            prisma.user.count({
                where: { vendorId },
            }),

            // Total leads count (filtered)
            prisma.lead.count({
                where: leadFilter,
            }),

            // Templates count
            prisma.template.count({
                where: { vendorId },
            }),

            // Campaigns count
            prisma.campaign.count({
                where: {
                    vendorId,
                    ...(user.role === 'sales' ? { createdBy: user.id } : {}),
                },
            }),

            // Leads by status (filtered)
            prisma.lead.groupBy({
                by: ["status"],
                where: leadFilter,
                _count: {
                    status: true,
                },
            }),
        ]);

        // Calculate conversion rate (converted / total)
        const convertedLeads = leadsStatusCount.find((s) => s.status === "converted")?._count.status || 0;
        const conversionRate = leadsCount > 0 ? Math.round((convertedLeads / leadsCount) * 100) : 0;

        // Prepare status breakdown with all essential statuses initialized
        const statusBreakdown = { new: 0, contacted: 0, qualified: 0, converted: 0, lost: 0 };
        leadsStatusCount.forEach((item) => {
            if (item.status) {
                // To safely handle unexpected custom statuses, initialize them if they don't exist
                if (statusBreakdown[item.status] === undefined && item.status !== '') {
                    statusBreakdown[item.status] = 0;
                }
                statusBreakdown[item.status] = item._count.status;
            }
        });

        // 2. Get recent campaign activities ONLY
        const recentCampaigns = await prisma.campaign.findMany({
            where: {
                vendorId,
                ...(user.role === 'sales' ? { createdBy: user.id } : {}),
            },
            select: {
                id: true,
                name: true,
                status: true,
                type: true,
                createdAt: true,
                createdBy: true,
                totalMessages: true,
                sentMessages: true,
                failedMessages: true
            },
            orderBy: { createdAt: "desc" },
            take: 15,
        });

        const campaignUserIds = [...new Set(recentCampaigns.map(c => c.createdBy).filter(Boolean))];
        const campaignUsers = await prisma.user.findMany({
            where: { id: { in: campaignUserIds } },
            select: { id: true, name: true }
        });
        const campaignUserMap = campaignUsers.reduce((acc, u) => {
            acc[u.id] = u.name;
            return acc;
        }, {});

        // Merge and format activities
        const events = [];

        recentCampaigns.forEach((camp) => {
            const campTypeStr = camp.type === 'TEMPLATE' ? 'Template Campaign' : 'Image Campaign';
            const memberName = campaignUserMap[camp.createdBy] || "System";
            
            let displayStatus = camp.status;
            // Infer correct status if DB still says active/processing
            if (camp.totalMessages > 0) {
                if (camp.failedMessages >= camp.totalMessages) {
                    displayStatus = 'failed';
                } else if ((camp.sentMessages + camp.failedMessages) >= camp.totalMessages) {
                    displayStatus = 'completed';
                } else if (camp.failedMessages > 0) {
                    displayStatus = 'partially failed';
                }
            }

            const actionText = `[Status: ${displayStatus}] ${campTypeStr}: ${camp.name || 'Unnamed'}`;
            events.push({ 
                member: memberName, 
                type: campTypeStr, 
                action: actionText, 
                time: camp.createdAt,
                stats: { sent: camp.sentMessages, failed: camp.failedMessages, total: camp.totalMessages }
            });
        });

        // Format final list (top 15)
        const activities = events.map((act, index) => ({
            id: `act_${index}_${new Date(act.time).getTime()}`,
            member: act.member,
            type: act.type || "System Event",
            action: act.action,
            stats: act.stats,
            time: formatTimeAgo(new Date(act.time)),
        }));

        res.json({
            stats: {
                teamMembers: teamCount,
                totalLeads: leadsCount,
                templates: templatesCount,
                campaigns: campaignsCount,
                conversionRate: `${conversionRate}%`,
                statusBreakdown,
            },
            recentActivities: activities,
        });
    } catch (error) {
        console.error("Dashboard stats error:", error);
        res.status(500).json({ message: "Failed to fetch dashboard statistics" });
    }
};

// Helper function to format time ago
function formatTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);

    const intervals = {
        year: 31536000,
        month: 2592000,
        week: 604800,
        day: 86400,
        hour: 3600,
        minute: 60,
    };

    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
        const interval = Math.floor(seconds / secondsInUnit);
        if (interval >= 1) {
            return `${interval} ${unit}${interval > 1 ? "s" : ""} ago`;
        }
    }

    return "Just now";
}
